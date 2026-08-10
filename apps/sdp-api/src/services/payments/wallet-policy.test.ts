import type { PolicyRule } from "@sdp/types";
import { describe, expect, it } from "vitest";
import {
  mergeWalletPolicyPatch,
  type WalletPolicyControlsPatch,
  type WalletPolicyControlsState,
} from "./wallet-policy";

const CURRENT_RULES: PolicyRule[] = [
  { id: "deny-raw-signing", kind: "operation_family", family: "raw_sign", action: "deny" },
];

const PATCH_RULES: PolicyRule[] = [
  { id: "deny-programs", kind: "operation_family", family: "program", action: "deny" },
];

const CURRENT: WalletPolicyControlsState = {
  destinationAllowlist: ["CurrentDestination111111111111111111111111"],
  maxTransferAmount: "5",
  maxDailyAmount: "50",
  controlProfile: { rules: CURRENT_RULES, defaultAction: "deny" },
};

const ALLOWLIST_BIT = 1 << 0;
const MAX_TRANSFER_BIT = 1 << 1;
const MAX_DAILY_BIT = 1 << 2;
const RULES_BIT = 1 << 3;
const DEFAULT_ACTION_BIT = 1 << 4;

describe("mergeWalletPolicyPatch", () => {
  it("changes exactly the named fields for every partial-field combination", () => {
    for (let mask = 0; mask < 1 << 5; mask++) {
      const patch: WalletPolicyControlsPatch = {
        ...(mask & ALLOWLIST_BIT
          ? { destinationAllowlist: ["PatchedDestination111111111111111111111111"] }
          : {}),
        ...(mask & MAX_TRANSFER_BIT ? { maxTransferAmount: "9" } : {}),
        ...(mask & MAX_DAILY_BIT ? { maxDailyAmount: "90" } : {}),
        ...(mask & RULES_BIT ? { rules: PATCH_RULES } : {}),
        ...(mask & DEFAULT_ACTION_BIT ? { defaultAction: "approval_required" as const } : {}),
      };

      expect(mergeWalletPolicyPatch(CURRENT, patch), `patch combination mask=${mask}`).toEqual({
        destinationAllowlist:
          mask & ALLOWLIST_BIT
            ? ["PatchedDestination111111111111111111111111"]
            : CURRENT.destinationAllowlist,
        maxTransferAmount: mask & MAX_TRANSFER_BIT ? "9" : "5",
        maxDailyAmount: mask & MAX_DAILY_BIT ? "90" : "50",
        controlProfile: {
          rules: mask & RULES_BIT ? PATCH_RULES : CURRENT_RULES,
          defaultAction: mask & DEFAULT_ACTION_BIT ? "approval_required" : "deny",
        },
      });
    }
  });

  it("clears each limit independently with explicit null", () => {
    expect(mergeWalletPolicyPatch(CURRENT, { maxTransferAmount: null })).toEqual({
      ...CURRENT,
      maxTransferAmount: undefined,
    });
    expect(mergeWalletPolicyPatch(CURRENT, { maxDailyAmount: null })).toEqual({
      ...CURRENT,
      maxDailyAmount: undefined,
    });
  });

  it("returns the current state unchanged for an empty patch", () => {
    expect(mergeWalletPolicyPatch(CURRENT, {})).toEqual(CURRENT);
  });

  it("clears rules with an explicit empty array while preserving the default action", () => {
    expect(mergeWalletPolicyPatch(CURRENT, { rules: [] })).toEqual({
      ...CURRENT,
      controlProfile: { rules: [], defaultAction: "deny" },
    });
  });

  it("bases an untouched profile field on implicit default-allow when no profile is active", () => {
    const noProfile: WalletPolicyControlsState = { ...CURRENT, controlProfile: null };

    expect(mergeWalletPolicyPatch(noProfile, { rules: PATCH_RULES }).controlProfile).toEqual({
      rules: PATCH_RULES,
      defaultAction: "allow",
    });
    expect(mergeWalletPolicyPatch(noProfile, { defaultAction: "deny" }).controlProfile).toEqual({
      rules: [],
      defaultAction: "deny",
    });
    expect(mergeWalletPolicyPatch(noProfile, { maxTransferAmount: "9" }).controlProfile).toBeNull();
  });
});
