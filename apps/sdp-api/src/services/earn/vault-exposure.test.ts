import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EarnStrategyRow } from "@/db/repositories/earn.repository";
import { AppError } from "@/lib/errors";
import type { Env } from "@/types/env";

const logEvent = vi.hoisted(() => vi.fn());
vi.mock("@/runtime/money-path-events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/runtime/money-path-events")>()),
  logEvent,
}));

/**
 * The cap TABLE is mocked so these tests pin the resolution RULES (absent,
 * explicit, explicit null) rather than whichever vaults are listed today; the
 * default cap is the real one.
 */
const CAPPED_VAULT = "CappedVault11111111111111111111111111111111";
const UNCAPPED_VAULT = "UncappedVault1111111111111111111111111111111";
vi.mock("@/routes/earn/handlers/curation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/routes/earn/handlers/curation")>();
  return {
    ...actual,
    VAULT_EXPOSURE_CAPS: {
      devnet: {
        [`kamino:${CAPPED_VAULT}`]: { maxShareOfTvlBps: 5000, maxAbsolute: "100" },
        [`kamino:${UNCAPPED_VAULT}`]: null,
      },
    },
  };
});

const { DEFAULT_VAULT_EXPOSURE_CAP } = await import("@/routes/earn/handlers/curation");
const {
  EARN_VOLUME_CAP_EVALUATED_EVENT,
  assessVaultExposure,
  createVaultExposureReader,
  evaluateVaultExposure,
  resolveVaultExposureCap,
  strategyTvlForExposure,
  vaultExposureBlockingIssue,
} = await import("./vault-exposure");

const cap = { maxShareOfTvlBps: 1000, maxAbsolute: "5000000" };

describe("evaluateVaultExposure", () => {
  it("admits a deposit under both bounds", () => {
    const verdict = evaluateVaultExposure({
      cap,
      exposure: "1000",
      tvl: "50000000",
      amount: "10",
    });
    // 10% of 50M ties the 5M ceiling; a tie keeps the absolute bound.
    expect(verdict).toEqual({
      wouldBlock: false,
      reason: "absolute",
      limit: "5000000",
      exposure: "1000",
      projected: "1010",
    });
  });

  it("admits a deposit landing exactly on the ceiling", () => {
    const verdict = evaluateVaultExposure({
      cap,
      exposure: "4999990",
      tvl: null,
      amount: "10",
    });
    expect(verdict.wouldBlock).toBe(false);
    expect(verdict.projected).toBe("5000000");
  });

  it("blocks on the absolute ceiling when TVL would allow more", () => {
    const verdict = evaluateVaultExposure({
      cap,
      exposure: "4999999.5",
      tvl: "1000000000",
      amount: "1",
    });
    expect(verdict).toMatchObject({
      wouldBlock: true,
      reason: "absolute",
      limit: "5000000",
      projected: "5000000.5",
    });
  });

  it("blocks on the share of TVL when that is the tighter bound", () => {
    // 10% of a 2M vault is 200k, well under the 5M ceiling.
    const verdict = evaluateVaultExposure({
      cap,
      exposure: "199999",
      tvl: "2000000",
      amount: "2",
    });
    expect(verdict).toMatchObject({
      wouldBlock: true,
      reason: "share_of_tvl",
      limit: "200000",
      projected: "200001",
    });
  });

  it("falls back to the absolute ceiling alone, and says so, when TVL is unknown", () => {
    for (const tvl of [null, "not-a-number", ""]) {
      const verdict = evaluateVaultExposure({ cap, exposure: "0", tvl, amount: "5000001" });
      expect(verdict).toMatchObject({
        wouldBlock: true,
        reason: "absolute_tvl_unavailable",
        limit: "5000000",
      });
    }
  });

  it("never blocks an explicitly uncapped vault", () => {
    const verdict = evaluateVaultExposure({
      cap: null,
      exposure: "999999999999",
      tvl: "1",
      amount: "1",
    });
    expect(verdict).toEqual({
      wouldBlock: false,
      reason: "uncapped",
      limit: null,
      exposure: "999999999999",
      projected: "1000000000000",
    });
  });

  it("does decimal math exactly", () => {
    const verdict = evaluateVaultExposure({
      cap: { maxShareOfTvlBps: 3333, maxAbsolute: "0.3" },
      exposure: "0.1",
      tvl: "0.9",
      amount: "0.2",
    });
    // 33.33% of 0.9 is 0.29997, truncated to TVL's scale: 0.2 (never up).
    expect(verdict).toMatchObject({
      wouldBlock: true,
      reason: "share_of_tvl",
      limit: "0.2",
      projected: "0.3",
    });
  });
});

describe("resolveVaultExposureCap", () => {
  it("applies the platform default to an absent entry", () => {
    expect(resolveVaultExposureCap("devnet", "kamino", "SomeOtherVault")).toEqual(
      DEFAULT_VAULT_EXPOSURE_CAP
    );
    // A cluster with no table at all is still capped.
    expect(resolveVaultExposureCap("mainnet-beta", "kamino", CAPPED_VAULT)).toEqual(
      DEFAULT_VAULT_EXPOSURE_CAP
    );
  });

  it("uses an explicit entry for its vault only", () => {
    expect(resolveVaultExposureCap("devnet", "kamino", CAPPED_VAULT)).toEqual({
      maxShareOfTvlBps: 5000,
      maxAbsolute: "100",
    });
    // Same address under another provider is a different key.
    expect(resolveVaultExposureCap("devnet", "veda", CAPPED_VAULT)).toEqual(
      DEFAULT_VAULT_EXPOSURE_CAP
    );
  });

  it("treats an explicit null as uncapped", () => {
    expect(resolveVaultExposureCap("devnet", "kamino", UNCAPPED_VAULT)).toBeNull();
  });
});

describe("strategyTvlForExposure", () => {
  it("reads a numeric tvlUsd and rejects everything else", () => {
    const row = (riskMetadata: Record<string, unknown>) =>
      ({ risk_metadata: riskMetadata }) as Pick<EarnStrategyRow, "risk_metadata">;
    expect(strategyTvlForExposure(row({ tvlUsd: 251_000_000 }))).toBe("251000000");
    expect(strategyTvlForExposure(row({ tvlUsd: 12.5 }))).toBe("12.5");
    expect(strategyTvlForExposure(row({}))).toBeNull();
    expect(strategyTvlForExposure(row({ tvlUsd: "251000000" }))).toBeNull();
    expect(strategyTvlForExposure(row({ tvlUsd: -1 }))).toBeNull();
    expect(strategyTvlForExposure(row({ tvlUsd: Number.NaN }))).toBeNull();
    expect(strategyTvlForExposure(row({ tvlUsd: 1e22 }))).toBeNull();
  });
});

describe("createVaultExposureReader", () => {
  const key = { environment: "sandbox" as const, provider: "kamino", vaultAddress: CAPPED_VAULT };
  const db = {} as Parameters<ReturnType<typeof createVaultExposureReader>["read"]>[0];

  beforeEach(() => {
    logEvent.mockClear();
  });

  it("serves a second read inside the TTL from cache and re-reads after it", async () => {
    let clock = 1_000_000;
    const sum = vi.fn().mockResolvedValueOnce("10").mockResolvedValueOnce("20");
    const reader = createVaultExposureReader({ sum, ttlMs: 30_000, now: () => clock });

    expect(await reader.read(db, key)).toBe("10");
    clock += 29_999;
    expect(await reader.read(db, key)).toBe("10");
    expect(sum).toHaveBeenCalledTimes(1);

    clock += 1;
    expect(await reader.read(db, key)).toBe("20");
    expect(sum).toHaveBeenCalledTimes(2);
  });

  it("keys the cache on environment, provider and vault", async () => {
    const sum = vi.fn().mockResolvedValue("1");
    const reader = createVaultExposureReader({ sum, now: () => 0 });
    await reader.read(db, key);
    await reader.read(db, { ...key, environment: "production" });
    await reader.read(db, { ...key, provider: "veda" });
    await reader.read(db, { ...key, vaultAddress: UNCAPPED_VAULT });
    await reader.read(db, key);
    expect(sum).toHaveBeenCalledTimes(4);
  });

  it("does not cache a failed read", async () => {
    const sum = vi.fn().mockRejectedValueOnce(new Error("pool exhausted")).mockResolvedValue("7");
    const reader = createVaultExposureReader({ sum, now: () => 0 });
    await expect(reader.read(db, key)).rejects.toThrow("pool exhausted");
    expect(await reader.read(db, key)).toBe("7");
  });

  it("clamps a negative sum to zero and logs the drift", async () => {
    const reader = createVaultExposureReader({
      sum: vi.fn().mockResolvedValue("-5"),
      now: () => 0,
    });
    expect(await reader.read(db, key)).toBe("0");
    expect(logEvent).toHaveBeenCalledWith(
      "warn",
      expect.objectContaining({ event: "sdp_api_earn_vault_exposure_negative", exposure: "-5" })
    );
  });
});

describe("assessVaultExposure", () => {
  const strategy = {
    provider: "kamino",
    provider_reference: CAPPED_VAULT,
    risk_metadata: {},
  } satisfies Pick<EarnStrategyRow, "provider" | "provider_reference" | "risk_metadata">;

  beforeEach(() => {
    logEvent.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function evaluatedEvents() {
    return logEvent.mock.calls.filter(
      ([, payload]) => payload?.event === EARN_VOLUME_CAP_EVALUATED_EVENT
    );
  }

  it("emits the evaluated event on an admitted deposit", async () => {
    const verdict = await assessVaultExposure({
      env: {} as Env,
      environment: "sandbox",
      strategy,
      amount: "10",
      readExposure: async () => "50",
    });
    expect(verdict).toEqual({
      enforced: false,
      evaluation: expect.objectContaining({ wouldBlock: false, projected: "60", limit: "100" }),
    });
    expect(evaluatedEvents()).toEqual([
      [
        "info",
        {
          event: EARN_VOLUME_CAP_EVALUATED_EVENT,
          cap: "vault_exposure",
          environment: "sandbox",
          provider: "kamino",
          vault_address: CAPPED_VAULT,
          exposure: "50",
          tvl: null,
          amount: "10",
          projected: "60",
          limit: "100",
          reason: "absolute_tvl_unavailable",
          would_block: false,
          enforced: false,
        },
      ],
    ]);
  });

  it("reports would_block without enforcing in shadow mode, and enforces under the flag", async () => {
    const input = {
      environment: "sandbox" as const,
      strategy,
      amount: "10",
      readExposure: async () => "95",
    };
    const shadow = await assessVaultExposure({ ...input, env: {} as Env });
    expect(shadow).toEqual({
      enforced: false,
      evaluation: expect.objectContaining({ wouldBlock: true, projected: "105", limit: "100" }),
    });
    expect(vaultExposureBlockingIssue(shadow)).toBeNull();
    expect(evaluatedEvents().at(-1)).toEqual([
      "warn",
      expect.objectContaining({ would_block: true, enforced: false }),
    ]);

    const enforced = await assessVaultExposure({
      ...input,
      env: { EARN_VOLUME_CAPS_ENFORCED: "true" } as Env,
    });
    expect(enforced.enforced).toBe(true);
    expect(vaultExposureBlockingIssue(enforced)).toEqual({
      code: "VAULT_EXPOSURE_CAP",
      message: expect.stringContaining("105"),
    });
    expect(evaluatedEvents().at(-1)).toEqual([
      "warn",
      expect.objectContaining({ would_block: true, enforced: true }),
    ]);
  });

  it("fails closed with a 503 when the exposure cannot be read, in shadow mode too", async () => {
    const read = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("ledger down"), { code: "ECONN" }));
    await expect(
      assessVaultExposure({
        env: {} as Env,
        environment: "sandbox",
        strategy,
        amount: "10",
        readExposure: read,
      })
    ).rejects.toMatchObject({ statusCode: 503, code: "SERVICE_UNAVAILABLE" });
    expect(evaluatedEvents()).toEqual([
      [
        "error",
        expect.objectContaining({
          cap: "vault_exposure",
          vault_address: CAPPED_VAULT,
          amount: "10",
          enforced: false,
          error_name: "Error",
          error_code: "ECONN",
          error_message: "ledger down",
        }),
      ],
    ]);
  });

  it("uses the catalogue TVL for the share bound", async () => {
    const verdict = await assessVaultExposure({
      env: {} as Env,
      environment: "sandbox",
      strategy: { ...strategy, risk_metadata: { tvlUsd: 100 } },
      amount: "1",
      readExposure: async () => "50",
    });
    // Explicit devnet cap: 50% of a 100 TVL is 50, tighter than the 100 ceiling.
    expect(verdict.evaluation).toMatchObject({
      wouldBlock: true,
      reason: "share_of_tvl",
      limit: "50",
      projected: "51",
    });
    expect(evaluatedEvents()[0]?.[1]).toMatchObject({ tvl: "100" });
  });

  it("never throws the typed refusal itself: that is the admission step's job", async () => {
    // Belt and braces for the contract the route tests pin end to end.
    const verdict = await assessVaultExposure({
      env: { EARN_VOLUME_CAPS_ENFORCED: "true" } as Env,
      environment: "sandbox",
      strategy,
      amount: "1000",
      readExposure: async () => "0",
    });
    expect(verdict.evaluation.wouldBlock).toBe(true);
    expect(verdict).not.toBeInstanceOf(AppError);
  });
});
