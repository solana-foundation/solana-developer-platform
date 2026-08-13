import { describe, expect, it } from "vitest";
import {
  isPolicyControlInSync,
  parseLamportAmount,
  parseSponsorshipNetwork,
  parseSponsorshipPolicyLimits,
  parseSponsorshipScope,
  toRedisLuaSafePolicyLimits,
} from "./sponsorship-budget-operator";

describe("sponsorship budget operator validation", () => {
  it.each(["1e6", "1.0", "+1", "-1", "01", " 1", "1 ", "", undefined])(
    "rejects non-canonical lamport input %s",
    (value) => {
      expect(() => parseLamportAmount(value, "hourly-lamports")).toThrow();
    }
  );

  it("parses canonical decimal strings as bigint without rounding", () => {
    expect(parseLamportAmount("0", "hourly-lamports")).toBe(0n);
    expect(parseLamportAmount("10000000", "hourly-lamports")).toBe(10_000_000n);
    expect(parseLamportAmount("9007199254740993", "daily-lamports")).toBe(9_007_199_254_740_993n);
  });

  it("validates limit ordering as bigint before safe-number conversion", () => {
    expect(() =>
      parseSponsorshipPolicyLimits({
        perTransactionLamports: "9007199254740993",
        hourlyLamports: "9007199254740992",
        dailyLamports: "9007199254740994",
      })
    ).toThrow("--hourly-lamports must be at least");
    expect(() =>
      parseSponsorshipPolicyLimits({
        perTransactionLamports: "1",
        hourlyLamports: "9007199254740994",
        dailyLamports: "9007199254740993",
      })
    ).toThrow("--daily-lamports must be at least");
  });

  it("converts only safe bigint limits at the Redis-Lua boundary", () => {
    expect(
      toRedisLuaSafePolicyLimits({
        perTransactionLamports: 10_000_000n,
        hourlyLamports: 1_000_000_000n,
        dailyLamports: 3_000_000_000n,
      })
    ).toEqual({
      perTransactionLamports: 10_000_000,
      hourlyLamports: 1_000_000_000,
      dailyLamports: 3_000_000_000,
    });
    expect(() =>
      toRedisLuaSafePolicyLimits({
        perTransactionLamports: 1n,
        hourlyLamports: 2n,
        dailyLamports: 9_007_199_254_740_992n,
      })
    ).toThrow("Redis-Lua safe integer range");
  });

  it("requires an explicit valid network", () => {
    expect(parseSponsorshipNetwork("devnet")).toBe("devnet");
    expect(parseSponsorshipNetwork("mainnet")).toBe("mainnet");
    expect(() => parseSponsorshipNetwork(undefined)).toThrow("--network is required");
    expect(() => parseSponsorshipNetwork("mainnet-beta")).toThrow("--network is required");
  });

  it("rejects global scope IDs and keeps omitted tenant IDs as defaults", () => {
    expect(parseSponsorshipScope(undefined, undefined)).toEqual({
      scopeType: "global",
      scopeId: null,
    });
    expect(() => parseSponsorshipScope("global", "org_1")).toThrow(
      "--scope-id is not valid for global"
    );
    expect(parseSponsorshipScope("organization", undefined)).toEqual({
      scopeType: "organization",
      scopeId: null,
    });
    expect(parseSponsorshipScope("project", "project_1")).toEqual({
      scopeType: "project",
      scopeId: "project_1",
    });
    expect(() => parseSponsorshipScope("project", "")).toThrow("cannot be empty");
  });

  it("detects missing, stale, and enabled-state Redis drift", () => {
    const policy = { version: 3, enabled: true };
    expect(isPolicyControlInSync(policy, null)).toBe(false);
    expect(isPolicyControlInSync(policy, { version: 2, enabled: true })).toBe(false);
    expect(isPolicyControlInSync(policy, { version: 3, enabled: false })).toBe(false);
    expect(isPolicyControlInSync(policy, { version: 3, enabled: true })).toBe(true);
  });
});
