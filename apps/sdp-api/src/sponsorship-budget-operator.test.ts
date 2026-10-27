import { describe, expect, it } from "vitest";
import {
  isPolicyControlInSync,
  parseLamportAmount,
  parseSponsorshipBudgetCommand,
  parseSponsorshipPolicyLimits,
  toRedisLuaSafePolicyLimits,
} from "@/scripts/lib/sponsorship-budget-operator";

const SET_PROJECT_FLAGS = {
  environment: "production",
  mode: "apply",
  operator: "oncall@example.test",
  reason: "raise launch limits",
  "organization-id": "org_operator_1",
  "per-tx-lamports": "10000000",
  "hourly-lamports": "1000000000",
  "daily-lamports": "3000000000",
  enabled: "true",
  "expected-version": "4",
};

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

  it("detects missing, stale, and enabled-state Redis drift", () => {
    const policy = { version: 3, enabled: true };
    expect(isPolicyControlInSync(policy, null)).toBe(false);
    expect(isPolicyControlInSync(policy, { version: 2, enabled: true })).toBe(false);
    expect(isPolicyControlInSync(policy, { version: 3, enabled: false })).toBe(false);
    expect(isPolicyControlInSync(policy, { version: 3, enabled: true })).toBe(true);
  });
});

describe("parseSponsorshipBudgetCommand", () => {
  it("parses a production set-project apply", () => {
    expect(
      parseSponsorshipBudgetCommand({ command: "set-project", flags: SET_PROJECT_FLAGS })
    ).toEqual({
      command: "set-project",
      environment: "production",
      organizationId: "org_operator_1",
      mode: "apply",
      operator: "oncall@example.test",
      reason: "raise launch limits",
      enabled: true,
      expectedVersion: 4,
      perTransactionLamports: 10_000_000,
      hourlyLamports: 1_000_000_000,
      dailyLamports: 3_000_000_000,
    });
  });

  it("parses a set-project preview that names no version", () => {
    const flags = Object.fromEntries(
      Object.entries({ ...SET_PROJECT_FLAGS, mode: "preview" }).filter(
        ([name]) => name !== "expected-version"
      )
    );
    expect(parseSponsorshipBudgetCommand({ command: "set-project", flags })).toEqual({
      command: "set-project",
      environment: "production",
      organizationId: "org_operator_1",
      mode: "preview",
      operator: "oncall@example.test",
      reason: "raise launch limits",
      enabled: true,
      expectedVersion: null,
      perTransactionLamports: 10_000_000,
      hourlyLamports: 1_000_000_000,
      dailyLamports: 3_000_000_000,
    });
  });

  it("parses a sandbox kill without a version", () => {
    expect(
      parseSponsorshipBudgetCommand({
        command: "kill",
        flags: {
          environment: "sandbox",
          mode: "preview",
          operator: "oncall@example.test",
          reason: "incident",
        },
      })
    ).toEqual({
      command: "kill",
      environment: "sandbox",
      mode: "preview",
      operator: "oncall@example.test",
      reason: "incident",
    });
  });

  it("refuses a flag the command does not take", () => {
    expect(() =>
      parseSponsorshipBudgetCommand({
        command: "set-project",
        flags: { ...SET_PROJECT_FLAGS, network: "mainnet" },
      })
    ).toThrow('Unrecognized key: "network"');
  });

  it.each([
    { flag: "mode", message: "--mode must be preview or apply" },
    { flag: "expected-version", message: "--expected-version is required" },
    { flag: "enabled", message: "--enabled must be true or false" },
    { flag: "organization-id", message: "--organization-id is required" },
  ])("refuses a set-project without --$flag", ({ flag, message }) => {
    const flags = Object.fromEntries(
      Object.entries(SET_PROJECT_FLAGS).filter(([name]) => name !== flag)
    );
    expect(() => parseSponsorshipBudgetCommand({ command: "set-project", flags })).toThrow(message);
  });

  it("refuses a resume that names no version", () => {
    expect(() =>
      parseSponsorshipBudgetCommand({
        command: "resume",
        flags: {
          environment: "production",
          mode: "apply",
          operator: "oncall@example.test",
          reason: "incident resolved",
        },
      })
    ).toThrow("--expected-version is required");
  });
});
