import type { EarnVaultPositionInput, EarnVaultPositionSnapshot } from "@sdp/earn/types";
import { readFloor, withRpcReadContext } from "@sdp/rpc/read-context";
import { createRpcFromTransport, getAccountInfo } from "@sdp/rpc/solana";
import type { SdpEnvironment } from "@sdp/types";
import type { Address, RpcTransport } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createVaultDeadline, VaultDeadline } from "@/services/earn/vault-deadline";
import type { AppContext } from "../context";
import {
  closeEmptyHydratedPositions,
  describeHydrationFailure,
  type HydratableVaultPosition,
  type HydratedVaultPositionValue,
  hydratedHoldingTokenValue,
  hydrateVaultPositions,
  markVaultPositionRowsRead,
} from "./vault-position-hydration";

const mocks = vi.hoisted(() => ({ readVaultPositions: vi.fn(), resolveClient: vi.fn() }));
vi.mock("@/services/earn/execution-registry", () => ({
  earnClusterFor: (environment: string) =>
    environment === "production" ? "mainnet-beta" : "devnet",
  resolveVaultDirectClient: mocks.resolveClient,
}));
vi.mock("@/services/earn/vault-deadline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/earn/vault-deadline")>();
  return { ...actual, createVaultDeadline: vi.fn(actual.createVaultDeadline) };
});

const WYLDS = "8fr7WGTVFszfyNWRMXj6fRjZZAnDwmXwEpCrtzmUkdih";
const OWNER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

describe("closeEmptyHydratedPositions", () => {
  it("keeps a position whose shares are gone while its par intermediate remains", async () => {
    const positions = [
      { id: "residual", closedAt: null, updatedAt: "2026-09-29T00:00:00.000Z" },
      { id: "empty", closedAt: null, updatedAt: "2026-09-29T00:00:00.000Z" },
    ];
    const live = new Map<string, HydratedVaultPositionValue>([
      [
        "residual",
        {
          shares: "0",
          withdrawableShares: "0",
          tokenValue: "0",
          parIntermediate: {
            mint: WYLDS,
            amount: "2000",
            withdrawableAmount: "2000",
            tokenValue: "2000",
          },
        },
      ],
      ["empty", { shares: "0", withdrawableShares: "0", tokenValue: "0" }],
    ]);
    const close = vi.fn(async () => true);

    await closeEmptyHydratedPositions(close, positions, live);

    expect(close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledWith("empty", "2026-09-29T00:00:00.000Z");
  });

  it("bounds close-out writes while still attempting every empty position", async () => {
    const positions = Array.from({ length: 20 }, (_, index) => ({
      id: `position_${index}`,
      closedAt: null,
      updatedAt: `2026-09-22T00:00:${String(index).padStart(2, "0")}.000Z`,
    }));
    const live = new Map<string, HydratedVaultPositionValue>(
      positions.map((position) => [
        position.id,
        { shares: "0", withdrawableShares: "0", tokenValue: "0" },
      ])
    );
    let active = 0;
    let maximum = 0;
    const close = vi.fn(async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return true;
    });

    await closeEmptyHydratedPositions(close, positions, live);

    expect(close).toHaveBeenCalledTimes(20);
    expect(maximum).toBe(8);
  });
});

describe("hydratedHoldingTokenValue", () => {
  it("adds the par intermediate to the shares' value and never invents one", () => {
    const intermediate = {
      mint: WYLDS,
      amount: "2000",
      withdrawableAmount: "2000",
      tokenValue: "2000",
    };
    expect(
      hydratedHoldingTokenValue({
        shares: "80",
        withdrawableShares: "80",
        tokenValue: "100.5",
        parIntermediate: intermediate,
      })
    ).toBe("2100.5");
    expect(
      hydratedHoldingTokenValue({ shares: "80", withdrawableShares: "80", tokenValue: "100.5" })
    ).toBe("100.5");
    expect(
      hydratedHoldingTokenValue({
        shares: "80",
        withdrawableShares: "80",
        tokenValue: undefined,
        parIntermediate: intermediate,
      })
    ).toBeUndefined();
    expect(hydratedHoldingTokenValue(undefined)).toBeUndefined();
  });
});

describe("describeHydrationFailure", () => {
  it("flattens a fan-out failure down to its socket cause, without the endpoint or owner", () => {
    const socket = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
    const failure = Object.assign(
      new Error("Veda could not read 1 of 1 requested vault positions", {
        cause: new AggregateError(
          [
            new Error(`Veda vault vault_1 read failed for ${OWNER}`, {
              cause: new Error(
                "request to https://rpc.example.invalid/PATH_KEY?api-key=QUERY_KEY failed",
                { cause: new TypeError("fetch failed", { cause: socket }) }
              ),
            }),
          ],
          "Veda vault position reads failed"
        ),
      }),
      { name: "SdpVedaError", code: "VAULT_UNREADABLE" }
    );

    const chain = describeHydrationFailure(failure, OWNER);

    expect(chain).toEqual([
      "SdpVedaError[VAULT_UNREADABLE]: Veda could not read 1 of 1 requested vault positions",
      "AggregateError: Veda vault position reads failed",
      "Error: Veda vault vault_1 read failed for [owner]",
      "Error: request to [url] failed",
      "TypeError: fetch failed",
      "Error[UND_ERR_SOCKET]: other side closed",
    ]);
    expect(JSON.stringify(chain)).not.toMatch(/PATH_KEY|QUERY_KEY/);
  });

  it("drops a bare query string, clips long text, and stops at a cycle", () => {
    const cyclic = new Error("rpc.example.invalid/?api-key=QUERY_KEY refused");
    cyclic.cause = cyclic;
    expect(describeHydrationFailure(cyclic)).toEqual([
      "Error: rpc.example.invalid/[query] refused",
    ]);
    expect(describeHydrationFailure(new Error("x".repeat(1_000)))).toEqual([
      `Error: ${"x".repeat(293)}...`,
    ]);
  });
});

describe("hydrateVaultPositions shares identical provider reads in flight", () => {
  const OTHER_OWNER = "3nMFwZXwY1s1M5s8vYAHqd4wGs4iSxXE4LRoUMMYqEgF";
  const TOKEN = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const SHARE = "So11111111111111111111111111111111111111112";
  const VALUE = { shares: "2", withdrawableShares: "2", tokenValue: "2.5" };
  const EMPTY = { shares: "0", withdrawableShares: "0", tokenValue: "0" };

  const context = (environment: SdpEnvironment = "sandbox", env: Record<string, string> = {}) =>
    ({
      env,
      get: (key: string) => (key === "apiKey" ? { environment } : undefined),
    }) as unknown as AppContext;
  const holding = (
    id: string,
    providerReference: string,
    ownerAddress = OWNER
  ): HydratableVaultPosition => ({
    id,
    provider: "kamino",
    providerReference,
    ownerAddress,
    tokenMint: TOKEN,
    shareMint: SHARE,
  });

  /** Provider reads that settle only when told to, answering every reference asked for. */
  function heldReads() {
    const pending: Array<{
      input: EarnVaultPositionInput;
      release: (value?: typeof VALUE) => void;
      fail: (error: Error) => void;
    }> = [];
    mocks.readVaultPositions.mockImplementation(
      (_ctx: unknown, input: EarnVaultPositionInput) =>
        new Promise<EarnVaultPositionSnapshot[]>((resolve, reject) => {
          pending.push({
            input,
            release: (value = VALUE) =>
              resolve(
                input.providerReferences.map((providerReference) => ({
                  providerReference,
                  owner: input.owner,
                  cluster: "devnet",
                  tokenMint: TOKEN,
                  shareMint: SHARE,
                  ...value,
                }))
              ),
            fail: reject,
          });
        })
    );
    return pending;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveClient.mockReturnValue({ readVaultPositions: mocks.readVaultPositions });
  });

  it("serves overlapping identical refreshes, in any reference order, from one provider read", async () => {
    const pending = heldReads();
    const positions = [holding("p1", "vault-a"), holding("p2", "vault-b")];
    // Both callers read their rows before either provider read started.
    const rowsReadAt = markVaultPositionRowsRead();

    const first = hydrateVaultPositions(context(), "sandbox", positions, {
      ownerKind: "custody",
      rowsReadAt,
    });
    const second = hydrateVaultPositions(context(), "sandbox", [...positions].reverse(), {
      ownerKind: "external-wallet",
      rowsReadAt,
    });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.input.providerReferences).toEqual(["vault-a", "vault-b"]);
    for (const read of pending) read.release();

    const expected = new Map([
      ["p1", VALUE],
      ["p2", VALUE],
    ]);
    await expect(first).resolves.toEqual(expected);
    await expect(second).resolves.toEqual(expected);
    expect(mocks.resolveClient).toHaveBeenCalledTimes(2);
  });

  it("never shares across a different environment, RPC endpoint, owner, reference set or minimum slot", async () => {
    const pending = heldReads();
    const options = { ownerKind: "custody" as const, rowsReadAt: markVaultPositionRowsRead() };
    const reads = [
      hydrateVaultPositions(context(), "sandbox", [holding("p1", "vault-a")], options),
      hydrateVaultPositions(
        context("production"),
        "production",
        [holding("p1", "vault-a")],
        options
      ),
      hydrateVaultPositions(
        context("sandbox", { SOLANA_DEVNET_RPC_URL: "https://devnet.rpc.invalid/?api-key=KEY" }),
        "sandbox",
        [holding("p1", "vault-a")],
        options
      ),
      hydrateVaultPositions(context(), "sandbox", [holding("p1", "vault-a", OTHER_OWNER)], options),
      hydrateVaultPositions(
        context(),
        "sandbox",
        [holding("p1", "vault-a"), holding("p3", "vault-c")],
        options
      ),
      hydrateVaultPositions(context(), "sandbox", [holding("p1", "vault-a")], {
        ...options,
        minimumSlotByPositionId: new Map([["p1", 101]]),
      }),
    ];
    expect(pending).toHaveLength(6);
    for (const read of pending) read.release();
    await Promise.all(reads);
  });

  it("runs every provider read under the caller's rows floor", async () => {
    const floors: Array<number | undefined> = [];
    mocks.readVaultPositions.mockImplementation(
      async (_ctx: unknown, input: EarnVaultPositionInput) => {
        floors.push(readFloor());
        return input.providerReferences.map((providerReference) => ({
          providerReference,
          owner: input.owner,
          cluster: "devnet",
          tokenMint: TOKEN,
          shareMint: SHARE,
          ...VALUE,
        }));
      }
    );
    const rowsReadAt = markVaultPositionRowsRead();

    await hydrateVaultPositions(
      context(),
      "sandbox",
      [holding("p1", "vault-a"), holding("p2", "vault-b", OTHER_OWNER)],
      { ownerKind: "custody", rowsReadAt }
    );

    expect(floors).toEqual([rowsReadAt, rowsReadAt]);
  });

  it("is not a cache: the next refresh reads again", async () => {
    const pending = heldReads();
    const first = hydrateVaultPositions(context(), "sandbox", [holding("p1", "vault-a")], {
      ownerKind: "custody",
      rowsReadAt: markVaultPositionRowsRead(),
    });
    pending[0]?.release();
    await first;
    const second = hydrateVaultPositions(context(), "sandbox", [holding("p1", "vault-a")], {
      ownerKind: "custody",
      rowsReadAt: markVaultPositionRowsRead(),
    });
    expect(pending).toHaveLength(2);
    pending[1]?.release();
    await expect(second).resolves.toEqual(new Map([["p1", VALUE]]));
  });

  it("shares a failure only with the callers already waiting on it", async () => {
    const pending = heldReads();
    const positions = [holding("p1", "vault-a")];
    const options = { ownerKind: "custody" as const, rowsReadAt: markVaultPositionRowsRead() };
    const first = hydrateVaultPositions(context(), "sandbox", positions, options);
    const second = hydrateVaultPositions(context(), "sandbox", positions, options);
    pending[0]?.fail(new Error("socket hang up"));
    await expect(first).resolves.toEqual(new Map());
    await expect(second).resolves.toEqual(new Map());

    const third = hydrateVaultPositions(context(), "sandbox", positions, {
      ownerKind: "custody",
      rowsReadAt: markVaultPositionRowsRead(),
    });
    expect(pending).toHaveLength(2);
    pending[1]?.release();
    await expect(third).resolves.toEqual(new Map([["p1", VALUE]]));
  });

  it("lets a joiner give up at its own deadline while the first caller's read goes on", async () => {
    const pending = heldReads();
    vi.mocked(createVaultDeadline)
      .mockReturnValueOnce(new VaultDeadline(20_000))
      .mockReturnValueOnce(new VaultDeadline(20));
    const positions = [holding("p1", "vault-a")];
    const options = { ownerKind: "custody" as const, rowsReadAt: markVaultPositionRowsRead() };
    const first = hydrateVaultPositions(context(), "sandbox", positions, options);
    const second = hydrateVaultPositions(context(), "sandbox", positions, options);

    await expect(second).resolves.toEqual(new Map());
    pending[0]?.release();
    await expect(first).resolves.toEqual(new Map([["p1", VALUE]]));
    expect(pending).toHaveLength(1);
  });

  it("never joins a read that started before its rows were read, so a stale zero cannot close a refilled holding", async () => {
    const pending = heldReads();
    // The stored row and the repository's compare-and-set on `updatedAt`.
    const stored = {
      id: "p1",
      closedAt: null as string | null,
      updatedAt: "2026-10-02T00:00:00.000Z",
    };
    const close = vi.fn(async (positionId: string, observedUpdatedAt: string) => {
      if (positionId !== stored.id || stored.closedAt !== null) return false;
      if (stored.updatedAt !== observedUpdatedAt) return false;
      stored.closedAt = "2026-10-02T00:00:02.000Z";
      return true;
    });
    const positions = [holding("p1", "vault-a")];

    // Request A reads the row, then its provider read starts and is held.
    const rowA = { ...stored };
    const first = hydrateVaultPositions(context(), "sandbox", positions, {
      ownerKind: "custody",
      rowsReadAt: markVaultPositionRowsRead(),
    });
    expect(pending).toHaveLength(1);

    // A deposit refills the holding, and its settlement bumps `updatedAt`.
    stored.updatedAt = "2026-10-02T00:00:01.000Z";

    // Request B reads the refilled row while A's read is still in flight.
    const rowB = { ...stored };
    const second = hydrateVaultPositions(context(), "sandbox", positions, {
      ownerKind: "custody",
      rowsReadAt: markVaultPositionRowsRead(),
    });
    expect(pending).toHaveLength(2);

    // A's chain read predates the deposit; B's own read sees it.
    pending[0]?.release(EMPTY);
    pending[1]?.release(VALUE);
    const [liveA, liveB] = await Promise.all([first, second]);
    expect(liveA.get("p1")).toEqual(EMPTY);
    expect(liveB.get("p1")).toEqual(VALUE);

    await closeEmptyHydratedPositions(close, [rowA], liveA);
    await closeEmptyHydratedPositions(close, [rowB], liveB);
    expect(close).toHaveBeenCalledTimes(1);
    await expect(close.mock.results[0]?.value).resolves.toBe(false);
    expect(stored.closedAt).toBeNull();
  });

  it.each([
    [101, VALUE],
    [100, undefined],
  ])(
    "shares one minimum-slot scope whose verdict holds for every caller: bank %s",
    async (bank, value) => {
      const requests: unknown[] = [];
      const transport: RpcTransport = async <T>(request: Parameters<RpcTransport>[0]) => {
        requests.push(request.payload);
        return { jsonrpc: "2.0", id: 1, result: { context: { slot: bank }, value: null } } as T;
      };
      const rpc = createRpcFromTransport(transport, { wrapTransport: withRpcReadContext });
      mocks.readVaultPositions.mockImplementation(
        async (_ctx: unknown, input: EarnVaultPositionInput) => {
          await getAccountInfo(rpc, input.owner as Address);
          return input.providerReferences.map((providerReference) => ({
            providerReference,
            owner: input.owner,
            cluster: "devnet",
            tokenMint: TOKEN,
            shareMint: SHARE,
            ...VALUE,
          }));
        }
      );
      const options = {
        ownerKind: "custody" as const,
        minimumSlotByPositionId: new Map([["p1", 101]]),
        rowsReadAt: markVaultPositionRowsRead(),
      };
      const positions = [holding("p1", "vault-a")];

      const results = await Promise.all([
        hydrateVaultPositions(context(), "sandbox", positions, options),
        hydrateVaultPositions(context(), "sandbox", positions, options),
      ]);

      expect(requests).toHaveLength(1);
      for (const live of results) expect(live.get("p1")).toEqual(value);
    }
  );
});
