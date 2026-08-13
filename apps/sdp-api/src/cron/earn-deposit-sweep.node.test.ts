import { SdpEarnError } from "@sdp/earn";
import type { EarnPortfolioWalletProvider } from "@sdp/earn/types";
import type { EarnPortfolioDeposit } from "@sdp/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EarnProviderWalletRow } from "@/db/repositories";
import type { Observability } from "@/runtime/observability";
import type { Env } from "@/types/env";

const SLOT_KEY = "cron:earn-deposit-sweep:slot";

/**
 * Harness mirrors `earn-catalogue-sync.node.test.ts`: no testcontainers, a mutable
 * provider registry, a faked repository, and a faked cache. The point of mocking
 * the REGISTRY LOOKUP rather than the exported registry object is that the sweep
 * dispatches through `resolveEarnProviderClient` — mocking the const would not
 * change what that function resolves.
 */
const mocks = vi.hoisted(() => ({
  resolveEarnProviderClient: vi.fn(),
  supportsPortfolioWallets: vi.fn(),
  scanProviderWallets: vi.fn(),
  applyEarnDepositObservation: vi.fn(),
  get: vi.fn(),
  put: vi.fn(),
  del: vi.fn(),
  compareAndSet: vi.fn(),
  compareAndDelete: vi.fn(),
}));

vi.mock("@sdp/earn", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@sdp/earn")>();
  return {
    ...actual,
    resolveEarnProviderClient: (id: string) => mocks.resolveEarnProviderClient(id),
    supportsPortfolioWallets: (client: unknown) => mocks.supportsPortfolioWallets(client),
  };
});

vi.mock("@/db/repositories", () => ({
  createEarnRepository: vi.fn(() => ({ scanProviderWallets: mocks.scanProviderWallets })),
}));

vi.mock("@/runtime/kv-redis", () => ({
  createKVStoreSet: vi.fn(() => ({
    cache: {
      get: mocks.get,
      put: mocks.put,
      delete: mocks.del,
      compareAndSet: mocks.compareAndSet,
      compareAndDelete: mocks.compareAndDelete,
    },
  })),
}));

vi.mock("@/services/earn-deposit-ledger.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/earn-deposit-ledger.service")>();
  return {
    ...actual,
    // The applier itself is covered exhaustively by the repository suite against
    // real Postgres; here we only care that the sweep hands it the right rows.
    applyEarnDepositObservation: (args: unknown) => mocks.applyEarnDepositObservation(args),
  };
});

import {
  EARN_DEPOSIT_SWEEP_CRON,
  EARN_DEPOSIT_SWEEP_DEADLINE_SECONDS,
  EARN_DEPOSIT_SWEEP_MONITOR,
  EARN_DEPOSIT_SWEEP_SLOT_TTL_SECONDS,
  runEarnDepositSweepIfDue,
} from "./earn-deposit-sweep";

const env = { DATABASE_URL: "postgres://unit", REDIS_URL: "redis://unit" } as Env;
const TOKEN_PATTERN = /^\d+:[0-9a-f-]{36}$/;

function makeWallet(overrides: Partial<EarnProviderWalletRow> = {}): EarnProviderWalletRow {
  return {
    id: "earn_provider_wallet_1",
    organization_id: "org_1",
    project_id: "prj_1",
    environment: "sandbox",
    provider: "veda",
    provider_wallet_ref: "wref_1",
    label: null,
    created_by: "user_1",
    created_at: "2026-08-12T00:00:00.000Z",
    updated_at: "2026-08-12T00:00:00.000Z",
    ...overrides,
  };
}

function makeClient(
  listPortfolioDeposits: EarnPortfolioWalletProvider["listPortfolioDeposits"]
): EarnPortfolioWalletProvider {
  return { provider: "veda", listPortfolioDeposits } as unknown as EarnPortfolioWalletProvider;
}

function makeObservability(): Observability {
  return {
    captureException: vi.fn(),
    withScope: vi.fn(),
    withMonitor: vi.fn((_slug, fn) => fn()),
  };
}

const DEPOSIT: EarnPortfolioDeposit = {
  id: "dep_1",
  amountUsd: "10.00",
  token: "usdc",
  status: "processing",
  createdAt: "2026-08-12T09:00:00.000Z",
};

function onePage(deposits: EarnPortfolioDeposit[], nextCursor: string | null = null) {
  return vi.fn(async () => ({ deposits, nextCursor }));
}

describe("runEarnDepositSweepIfDue", () => {
  beforeEach(() => {
    mocks.resolveEarnProviderClient.mockReset();
    mocks.supportsPortfolioWallets.mockReset().mockReturnValue(true);
    mocks.scanProviderWallets.mockReset().mockResolvedValue([]);
    mocks.applyEarnDepositObservation.mockReset().mockResolvedValue(null);
    // Empty, claimable slot and no persisted cursors.
    mocks.get.mockReset().mockResolvedValue(null);
    mocks.put.mockReset().mockResolvedValue(undefined);
    mocks.del.mockReset().mockResolvedValue(undefined);
    mocks.compareAndSet.mockReset().mockResolvedValue(true);
    mocks.compareAndDelete.mockReset().mockResolvedValue(true);
  });

  it("claims an empty slot with a single null-to-token transition and sweeps", async () => {
    await expect(runEarnDepositSweepIfDue(env)).resolves.toBe("swept");

    expect(mocks.compareAndSet).toHaveBeenCalledExactlyOnceWith(
      SLOT_KEY,
      null,
      expect.stringMatching(TOKEN_PATTERN)
    );
    const token = mocks.compareAndSet.mock.calls[0]?.[2] as string;
    expect(Number(token.slice(0, token.indexOf(":")))).toBeLessThanOrEqual(
      Date.now() + EARN_DEPOSIT_SWEEP_SLOT_TTL_SECONDS * 1000
    );
    expect(mocks.compareAndDelete).not.toHaveBeenCalled();
  });

  it("skips without sweeping or checking in while a live claim holds the slot", async () => {
    mocks.get.mockImplementation(async (key: string) =>
      key === SLOT_KEY ? `${Date.now() + 60_000}:11111111-1111-4111-8111-111111111111` : null
    );
    const observability = makeObservability();

    await expect(runEarnDepositSweepIfDue(env, observability)).resolves.toBe("skipped");

    expect(mocks.compareAndSet).not.toHaveBeenCalled();
    expect(mocks.scanProviderWallets).not.toHaveBeenCalled();
    // No monitor check-in on a skipped tick, so Sentry sees the real cadence
    // rather than the job's five-minute schedule.
    expect(observability.withMonitor).not.toHaveBeenCalled();
  });

  it("treats a pre-token legacy slot value as expired and takes it over", async () => {
    mocks.get.mockImplementation(async (key: string) => (key === SLOT_KEY ? "1" : null));

    await expect(runEarnDepositSweepIfDue(env)).resolves.toBe("swept");
    expect(mocks.compareAndSet).toHaveBeenCalledExactlyOnceWith(
      SLOT_KEY,
      "1",
      expect.stringMatching(TOKEN_PATTERN)
    );
  });

  it("skips when a racing tick wins the same claim transition", async () => {
    mocks.compareAndSet.mockResolvedValue(false);

    await expect(runEarnDepositSweepIfDue(env)).resolves.toBe("skipped");
    expect(mocks.scanProviderWallets).not.toHaveBeenCalled();
  });

  it("runs under its own monitor with its own crontab schedule", async () => {
    const observability = makeObservability();

    await runEarnDepositSweepIfDue(env, observability);

    expect(observability.withMonitor).toHaveBeenCalledExactlyOnceWith(
      EARN_DEPOSIT_SWEEP_MONITOR,
      expect.any(Function),
      { schedule: { type: "crontab", value: EARN_DEPOSIT_SWEEP_CRON } }
    );
  });

  it("releases only its own claim token when the pass fails, and rethrows", async () => {
    mocks.scanProviderWallets.mockRejectedValue(new Error("db down"));

    await expect(runEarnDepositSweepIfDue(env)).rejects.toThrow("db down");

    const token = mocks.compareAndSet.mock.calls[0]?.[2] as string;
    expect(mocks.compareAndDelete).toHaveBeenCalledExactlyOnceWith(SLOT_KEY, token);
  });

  it("never lets a slot-release failure mask the sweep error", async () => {
    mocks.scanProviderWallets.mockRejectedValue(new Error("db down"));
    mocks.compareAndDelete.mockRejectedValue(new Error("redis down"));

    await expect(runEarnDepositSweepIfDue(env)).rejects.toThrow("db down");
  });

  it("observes every deposit on a page", async () => {
    const wallet = makeWallet();
    mocks.scanProviderWallets.mockImplementation(
      async ({ environment }: { environment: string }) =>
        environment === "sandbox" ? [wallet] : []
    );
    mocks.resolveEarnProviderClient.mockReturnValue(
      makeClient(onePage([DEPOSIT, { ...DEPOSIT, id: "dep_2" }]))
    );

    await runEarnDepositSweepIfDue(env);

    expect(mocks.applyEarnDepositObservation).toHaveBeenCalledTimes(2);
    expect(mocks.applyEarnDepositObservation).toHaveBeenCalledWith(
      expect.objectContaining({
        wallet,
        observation: expect.objectContaining({
          source: "provider_poll",
          providerReference: "dep_1",
        }),
      })
    );
  });

  it("degrades per wallet: one failing program never sinks the pass", async () => {
    const bad = makeWallet({ id: "earn_provider_wallet_bad", provider: "veda" });
    const good = makeWallet({ id: "earn_provider_wallet_good", provider: "upshift" });
    mocks.scanProviderWallets.mockImplementation(
      async ({ environment }: { environment: string }) =>
        environment === "sandbox" ? [bad, good] : []
    );
    mocks.resolveEarnProviderClient.mockImplementation((id: string) =>
      id === "veda"
        ? makeClient(
            vi.fn(async () => {
              throw new Error("provider API down");
            })
          )
        : makeClient(onePage([DEPOSIT]))
    );

    await expect(runEarnDepositSweepIfDue(env)).resolves.toBe("swept");
    expect(mocks.applyEarnDepositObservation).toHaveBeenCalledTimes(1);
  });

  it("retries a failed wallet once in the same pass, so a blip is not left for the wrap", async () => {
    // The checkpoint advances past the whole batch, so a wallet that failed would
    // otherwise wait for the scan to wrap. A transient failure — the usual cause —
    // is recovered seconds later instead.
    const bad = makeWallet({ id: "earn_provider_wallet_flaky" });
    mocks.scanProviderWallets.mockImplementation(
      async ({ environment }: { environment: string }) => (environment === "sandbox" ? [bad] : [])
    );
    const listPortfolioDeposits = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce({ deposits: [DEPOSIT], nextCursor: null });
    mocks.resolveEarnProviderClient.mockReturnValue(makeClient(listPortfolioDeposits));

    await expect(runEarnDepositSweepIfDue(env)).resolves.toBe("swept");

    expect(listPortfolioDeposits).toHaveBeenCalledTimes(2);
    // The retry succeeded, so this is NOT reported as a failure an operator must act on.
    expect(mocks.applyEarnDepositObservation).toHaveBeenCalledTimes(1);
  });

  it("counts a wallet that fails BOTH attempts as one failure, and keeps the pass alive", async () => {
    const bad = makeWallet({ id: "earn_provider_wallet_broken", provider: "veda" });
    const good = makeWallet({ id: "earn_provider_wallet_ok", provider: "upshift" });
    mocks.scanProviderWallets.mockImplementation(
      async ({ environment }: { environment: string }) =>
        environment === "sandbox" ? [bad, good] : []
    );
    const brokenFeed = vi.fn(async () => {
      throw new Error("provider API down");
    });
    mocks.resolveEarnProviderClient.mockImplementation((id: string) =>
      id === "veda" ? makeClient(brokenFeed) : makeClient(onePage([DEPOSIT]))
    );

    await expect(runEarnDepositSweepIfDue(env)).resolves.toBe("swept");

    // Two attempts on the broken wallet; the healthy one is swept exactly once and
    // is never dragged into the retry.
    expect(brokenFeed).toHaveBeenCalledTimes(2);
    expect(mocks.applyEarnDepositObservation).toHaveBeenCalledTimes(1);
  });

  it("does not retry a wallet whose provider is a steady-state skip", async () => {
    // An un-credentialed or capability-less provider is not a failure, so retrying it
    // would double the log noise on exactly the pass an operator is reading.
    mocks.scanProviderWallets.mockImplementation(
      async ({ environment }: { environment: string }) =>
        environment === "sandbox" ? [makeWallet()] : []
    );
    const listPortfolioDeposits = vi.fn(async () => {
      throw new SdpEarnError("PROVIDER_NOT_CONFIGURED", "no key");
    });
    mocks.resolveEarnProviderClient.mockReturnValue(makeClient(listPortfolioDeposits));

    await expect(runEarnDepositSweepIfDue(env)).resolves.toBe("swept");

    expect(listPortfolioDeposits).toHaveBeenCalledTimes(1);
  });

  it("treats absent credentials as a steady state and skips the provider ONCE, not once per wallet", async () => {
    // An un-credentialed environment is the normal pre-launch state. Logging (and
    // calling) once per program would drown the signal on the exact pass an
    // operator reads during an incident.
    const wallets = [makeWallet({ id: "w1" }), makeWallet({ id: "w2" }), makeWallet({ id: "w3" })];
    mocks.scanProviderWallets.mockImplementation(
      async ({ environment }: { environment: string }) => (environment === "sandbox" ? wallets : [])
    );
    const listPortfolioDeposits = vi.fn(async () => {
      throw new SdpEarnError("PROVIDER_NOT_CONFIGURED", "no key");
    });
    mocks.resolveEarnProviderClient.mockReturnValue(makeClient(listPortfolioDeposits));

    await expect(runEarnDepositSweepIfDue(env)).resolves.toBe("swept");

    expect(listPortfolioDeposits).toHaveBeenCalledTimes(1);
    expect(mocks.applyEarnDepositObservation).not.toHaveBeenCalled();
    expect(mocks.compareAndDelete).not.toHaveBeenCalled();
  });

  it("skips a provider that lacks the portfolio capability", async () => {
    mocks.scanProviderWallets.mockImplementation(
      async ({ environment }: { environment: string }) =>
        environment === "sandbox" ? [makeWallet()] : []
    );
    mocks.resolveEarnProviderClient.mockReturnValue(makeClient(onePage([DEPOSIT])));
    // Never a provider-id check — the method-presence guard decides.
    mocks.supportsPortfolioWallets.mockReturnValue(false);

    await expect(runEarnDepositSweepIfDue(env)).resolves.toBe("swept");
    expect(mocks.applyEarnDepositObservation).not.toHaveBeenCalled();
  });

  it("fails closed on a row naming an unregistered provider", async () => {
    mocks.scanProviderWallets.mockImplementation(
      async ({ environment }: { environment: string }) =>
        environment === "sandbox" ? [makeWallet({ provider: "retired" })] : []
    );
    mocks.resolveEarnProviderClient.mockImplementation(() => {
      throw new SdpEarnError("PROVIDER_NOT_CONFIGURED", "retired is not available");
    });

    await expect(runEarnDepositSweepIfDue(env)).resolves.toBe("swept");
    expect(mocks.applyEarnDepositObservation).not.toHaveBeenCalled();
  });

  it("NEVER stops early on a fully-known page — the full walk is the whole point", async () => {
    // The feed has no `since` filter and an opaque cursor of undocumented order, so
    // every cheap stop rule is order-dependent and wrong in one direction. This test
    // exists so nobody reintroduces one as an "optimization".
    mocks.scanProviderWallets.mockImplementation(
      async ({ environment }: { environment: string }) =>
        environment === "sandbox" ? [makeWallet()] : []
    );
    const listPortfolioDeposits = vi
      .fn()
      .mockResolvedValueOnce({ deposits: [DEPOSIT], nextCursor: "page2" })
      .mockResolvedValueOnce({ deposits: [{ ...DEPOSIT, id: "dep_2" }], nextCursor: null });
    mocks.resolveEarnProviderClient.mockReturnValue(makeClient(listPortfolioDeposits));
    // Every row already resolves to a terminal ledger row — the steady state.
    mocks.applyEarnDepositObservation.mockResolvedValue({ status: "completed" });

    await runEarnDepositSweepIfDue(env);

    expect(listPortfolioDeposits).toHaveBeenCalledTimes(2);
  });

  it("clears the per-wallet cursor on a complete walk", async () => {
    mocks.scanProviderWallets.mockImplementation(
      async ({ environment }: { environment: string }) =>
        environment === "sandbox" ? [makeWallet()] : []
    );
    mocks.resolveEarnProviderClient.mockReturnValue(makeClient(onePage([DEPOSIT])));

    await runEarnDepositSweepIfDue(env);

    expect(mocks.del).toHaveBeenCalledWith("cron:earn-deposit-sweep:cursor:earn_provider_wallet_1");
  });

  it("caps pages per wallet and persists the unfinished cursor so the next pass advances", async () => {
    mocks.scanProviderWallets.mockImplementation(
      async ({ environment }: { environment: string }) =>
        environment === "sandbox" ? [makeWallet()] : []
    );
    // A feed that never ends: the cap is the only thing bounding it.
    const listPortfolioDeposits = vi.fn(async () => ({ deposits: [DEPOSIT], nextCursor: "more" }));
    mocks.resolveEarnProviderClient.mockReturnValue(makeClient(listPortfolioDeposits));

    await runEarnDepositSweepIfDue(env);

    expect(listPortfolioDeposits).toHaveBeenCalledTimes(20);
    // Bounded, not permanent: a resume pointer for a wallet that stops being swept
    // at all must expire rather than linger forever, and expiry is safe because
    // losing it only restarts that walk from the head.
    expect(mocks.put).toHaveBeenCalledWith(
      "cron:earn-deposit-sweep:cursor:earn_provider_wallet_1",
      "more",
      { expirationTtl: expect.any(Number) }
    );
    const putOptions = mocks.put.mock.calls[0]?.[2] as { expirationTtl: number } | undefined;
    expect(putOptions?.expirationTtl).toBeGreaterThan(0);
  });

  it("discards a persisted cursor the provider rejects, so one bad cursor cannot wedge a wallet forever", async () => {
    // The cursor is otherwise deleted ONLY on a complete walk, so a resume pointer
    // the provider stops accepting (expired, or a provider-side format change)
    // would make every later pass replay the identical failing request — that
    // wallet permanently excluded from unattended observation, while the sweep
    // still reports a healthy check-in.
    mocks.scanProviderWallets.mockImplementation(
      async ({ environment }: { environment: string }) =>
        environment === "sandbox" ? [makeWallet()] : []
    );
    mocks.get.mockImplementation(async (key: string) =>
      key === "cron:earn-deposit-sweep:cursor:earn_provider_wallet_1" ? "stale_cursor" : null
    );
    mocks.resolveEarnProviderClient.mockReturnValue(
      makeClient(
        vi.fn(async () => {
          throw new SdpEarnError("BAD_REQUEST", "unknown cursor");
        })
      )
    );

    // The pass still completes — one wallet failing never sinks the platform's.
    await expect(runEarnDepositSweepIfDue(env)).resolves.toBe("swept");

    expect(mocks.del).toHaveBeenCalledWith("cron:earn-deposit-sweep:cursor:earn_provider_wallet_1");
  });

  it.each([
    ["a rate limit", new SdpEarnError("RATE_LIMITED", "slow down")],
    ["a provider outage", new SdpEarnError("PROVIDER_UNAVAILABLE", "502")],
    ["a transport failure", new Error("socket hang up")],
  ])("KEEPS a resumed cursor when the failure is %s, not a rejection", async (_label, thrown) => {
    // None of these say anything about the cursor's validity, and discarding it on
    // them would throw away real pagination progress — for a wallet with more pages
    // than the per-pass cap that means the walk restarts at the head every time and
    // can never reach the end.
    mocks.scanProviderWallets.mockImplementation(
      async ({ environment }: { environment: string }) =>
        environment === "sandbox" ? [makeWallet()] : []
    );
    mocks.get.mockImplementation(async (key: string) =>
      key === "cron:earn-deposit-sweep:cursor:earn_provider_wallet_1" ? "deep_in_history" : null
    );
    mocks.resolveEarnProviderClient.mockReturnValue(
      makeClient(
        vi.fn(async () => {
          throw thrown;
        })
      )
    );

    await expect(runEarnDepositSweepIfDue(env)).resolves.toBe("swept");

    expect(mocks.del).not.toHaveBeenCalledWith(
      "cron:earn-deposit-sweep:cursor:earn_provider_wallet_1"
    );
  });

  it("keeps a cursor minted during THIS pass when a later page fails", async () => {
    // Only a cursor carried over from a previous pass can be stale. Deleting a
    // fresh one on any mid-walk failure would throw away real progress on a long
    // history and could re-walk the same pages forever.
    mocks.scanProviderWallets.mockImplementation(
      async ({ environment }: { environment: string }) =>
        environment === "sandbox" ? [makeWallet()] : []
    );
    const listPortfolioDeposits = vi
      .fn()
      .mockResolvedValueOnce({ deposits: [DEPOSIT], nextCursor: "page2" })
      .mockRejectedValueOnce(new Error("transport blip"));
    mocks.resolveEarnProviderClient.mockReturnValue(makeClient(listPortfolioDeposits));

    await expect(runEarnDepositSweepIfDue(env)).resolves.toBe("swept");

    // The point is FORWARD PROGRESS, so assert the put, not merely the absence of a
    // delete: page 1 succeeded, so its nextCursor must be persisted even though
    // page 2 then failed. Without it a deterministic page-2 failure would restart at
    // page 1 on every future tick and no later deposit could ever be recorded.
    expect(mocks.put).toHaveBeenCalledWith(
      "cron:earn-deposit-sweep:cursor:earn_provider_wallet_1",
      "page2",
      { expirationTtl: expect.any(Number) }
    );
    expect(mocks.del).not.toHaveBeenCalledWith(
      "cron:earn-deposit-sweep:cursor:earn_provider_wallet_1"
    );
  });

  it("persists each completed page's cursor as it walks, not once at the end", async () => {
    mocks.scanProviderWallets.mockImplementation(
      async ({ environment }: { environment: string }) =>
        environment === "sandbox" ? [makeWallet()] : []
    );
    const listPortfolioDeposits = vi
      .fn()
      .mockResolvedValueOnce({ deposits: [DEPOSIT], nextCursor: "page2" })
      .mockResolvedValueOnce({ deposits: [DEPOSIT], nextCursor: "page3" })
      .mockResolvedValueOnce({ deposits: [DEPOSIT], nextCursor: null });
    mocks.resolveEarnProviderClient.mockReturnValue(makeClient(listPortfolioDeposits));

    await runEarnDepositSweepIfDue(env);

    const cursorsPersisted = mocks.put.mock.calls
      .filter((call) => call[0] === "cron:earn-deposit-sweep:cursor:earn_provider_wallet_1")
      .map((call) => call[1]);
    expect(cursorsPersisted).toEqual(["page2", "page3"]);
    // ...and the completed walk clears it, so the next pass starts at the head.
    expect(mocks.del).toHaveBeenCalledWith("cron:earn-deposit-sweep:cursor:earn_provider_wallet_1");
  });

  it("resumes a wallet from its persisted cursor", async () => {
    mocks.scanProviderWallets.mockImplementation(
      async ({ environment }: { environment: string }) =>
        environment === "sandbox" ? [makeWallet()] : []
    );
    mocks.get.mockImplementation(async (key: string) =>
      key === "cron:earn-deposit-sweep:cursor:earn_provider_wallet_1" ? "resume_here" : null
    );
    const listPortfolioDeposits = onePage([DEPOSIT]);
    mocks.resolveEarnProviderClient.mockReturnValue(makeClient(listPortfolioDeposits));

    await runEarnDepositSweepIfDue(env);

    expect(listPortfolioDeposits).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ cursor: "resume_here" })
    );
  });

  it("sweeps both environments with the matching runtime context", async () => {
    mocks.scanProviderWallets.mockResolvedValue([]);

    await runEarnDepositSweepIfDue(env);

    expect(mocks.scanProviderWallets).toHaveBeenCalledTimes(2);
    expect(mocks.scanProviderWallets.mock.calls[0]?.[0]).toMatchObject({
      environment: "sandbox",
    });
    expect(mocks.scanProviderWallets.mock.calls[1]?.[0]).toMatchObject({
      environment: "production",
    });
  });

  it("advances the wallet-scan checkpoint only AFTER the batch is processed", async () => {
    // Checkpointing on fetch would point past wallets nothing swept if the pass ends
    // early (its deadline, the job's execution cap, or a kill), skipping those
    // programs until the scan wrapped all the way around. Ordering is the assertion:
    // the checkpoint write must come after the last observation of the batch.
    const wallets = Array.from({ length: 200 }, (_unused, index) =>
      makeWallet({
        id: `earn_provider_wallet_${index}`,
        created_at: `2026-08-12T00:00:0${index % 10}.000Z`,
      })
    );
    mocks.scanProviderWallets.mockImplementation(
      async ({ environment }: { environment: string }) => (environment === "sandbox" ? wallets : [])
    );
    mocks.resolveEarnProviderClient.mockReturnValue(makeClient(onePage([DEPOSIT])));

    await runEarnDepositSweepIfDue(env);

    const scanPut = mocks.put.mock.calls.find(
      (call) => call[0] === "cron:earn-deposit-sweep:wallet-scan:sandbox"
    );
    expect(scanPut).toBeDefined();
    // Every observation in the batch happened before the checkpoint moved.
    const lastObservation = Math.max(...mocks.applyEarnDepositObservation.mock.invocationCallOrder);
    const checkpointOrder = Math.min(
      ...mocks.put.mock.invocationCallOrder.filter(
        (_order, index) =>
          mocks.put.mock.calls[index]?.[0] === "cron:earn-deposit-sweep:wallet-scan:sandbox"
      )
    );
    expect(checkpointOrder).toBeGreaterThan(lastObservation);
  });

  it("never checkpoints a batch the deadline cut short", async () => {
    // The interruption that actually happens: the pass hits its deadline (or the
    // job's execution cap) partway through the batch. Because the checkpoint write
    // sits AFTER the wallet loop, it simply never runs — so the next pass re-walks
    // this batch instead of skipping the wallets nothing reached. Re-walking is free:
    // every observation is idempotent.
    vi.useFakeTimers();
    try {
      const wallets = Array.from({ length: 200 }, (_unused, index) =>
        makeWallet({ id: `earn_provider_wallet_${index}` })
      );
      mocks.scanProviderWallets.mockImplementation(
        async ({ environment }: { environment: string }) =>
          environment === "sandbox" ? wallets : []
      );
      const never = new Promise<never>(() => {});
      mocks.resolveEarnProviderClient.mockReturnValue(makeClient(vi.fn(() => never)));

      const tick = runEarnDepositSweepIfDue(env);
      const assertion = expect(tick).rejects.toThrow(
        `exceeded its ${EARN_DEPOSIT_SWEEP_DEADLINE_SECONDS}s deadline`
      );
      await vi.advanceTimersByTimeAsync(EARN_DEPOSIT_SWEEP_DEADLINE_SECONDS * 1000);
      await assertion;

      expect(mocks.put).not.toHaveBeenCalledWith(
        "cron:earn-deposit-sweep:wallet-scan:sandbox",
        expect.anything()
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the wallet-scan cursor when the scan comes back under the cap", async () => {
    mocks.scanProviderWallets.mockResolvedValue([]);

    await runEarnDepositSweepIfDue(env);

    expect(mocks.del).toHaveBeenCalledWith("cron:earn-deposit-sweep:wallet-scan:sandbox");
    expect(mocks.del).toHaveBeenCalledWith("cron:earn-deposit-sweep:wallet-scan:production");
  });
});
