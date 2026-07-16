import type { PaymentWalletPolicy } from "@sdp/types";
import { describe, expect, it } from "vitest";
import {
  buildDisabledPolicyPayload,
  buildPolicyPayload,
  createPolicyAuthoringState,
  formatProviderMappingLabel,
  loadPolicyDraft,
  parseDestinationText,
  policyDraftStorageKey,
  type StoredPolicyDraft,
  savePolicyDraft,
  validatePolicyState,
} from "./wallet-policy-authoring";

const WALLET_ID = "wallet_test";
const PROJECT_ID = "project_test";
const ADDRESS_A = "11111111111111111111111111111111";
const ADDRESS_B = "So11111111111111111111111111111111111111112";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }
}

function emptyPolicy(): PaymentWalletPolicy {
  return { walletId: WALLET_ID, destinationAllowlist: [] };
}

describe("wallet policy authoring", () => {
  it("validates restriction intent, decimal values, and the daily limit relationship", () => {
    const state = createPolicyAuthoringState(emptyPolicy());
    expect(validatePolicyState(state).intent).toBe("restriction_required");

    state.categories = ["limits"];
    state.maxTransferAmount = "10.25";
    state.maxDailyAmount = "10.24";
    expect(validatePolicyState(state).maxDailyAmount).toBe("daily_below_transaction");

    state.maxTransferAmount = "1.2.3";
    expect(validatePolicyState(state).maxTransferAmount).toBe("invalid_decimal");

    state.maxTransferAmount = "0.5";
    state.maxDailyAmount = "0.75";
    expect(validatePolicyState(state).maxDailyAmount).toBeUndefined();

    state.maxDailyAmount = "0.49";
    expect(validatePolicyState(state).maxDailyAmount).toBe("daily_below_transaction");
  });

  it("trims destinations, preserves first-seen order, de-duplicates, and reports invalid lines", () => {
    const parsed = parseDestinationText(
      `  ${ADDRESS_B}  \n${ADDRESS_A}\n${ADDRESS_B}\nnot-a-wallet\n`
    );

    expect(parsed.valid).toEqual([ADDRESS_B, ADDRESS_A]);
    expect(parsed.entries[2]).toMatchObject({ value: ADDRESS_B, duplicate: true, line: 3 });
    expect(parsed.invalid).toEqual([
      expect.objectContaining({ value: "not-a-wallet", line: 4, valid: false }),
    ]);
  });

  it("persists a project- and wallet-scoped local draft", () => {
    const storage = new MemoryStorage();
    const state = createPolicyAuthoringState(emptyPolicy());
    state.defaultAction = "deny";
    const draft: StoredPolicyDraft = {
      version: 1,
      projectId: PROJECT_ID,
      walletId: WALLET_ID,
      step: "limits-assets",
      state,
      updatedAt: "2026-07-15T20:00:00.000Z",
    };

    savePolicyDraft(storage, draft);

    expect(policyDraftStorageKey(PROJECT_ID, WALLET_ID)).toContain(`${PROJECT_ID}.${WALLET_ID}`);
    expect(loadPolicyDraft(storage, PROJECT_ID, WALLET_ID)).toEqual(draft);
    expect(loadPolicyDraft(storage, "another-project", WALLET_ID)).toBeNull();
  });

  it("builds an activation payload for every public authoring capability", () => {
    const state = createPolicyAuthoringState(emptyPolicy());
    state.defaultAction = "review";
    state.categories = ["limits", "assets", "destinations", "operations", "approvals"];
    state.maxTransferAmount = "100";
    state.maxDailyAmount = "500";
    state.assets = [ADDRESS_A];
    state.destinationMode = "allowlist";
    state.destinationText = ADDRESS_B;
    state.familyActions = { transfer: "deny", payment: "approval_required" };
    state.operationTypeRules = [{ value: "payment.create", action: "review" }];
    state.approvalFamilies = ["ramp"];

    const payload = buildPolicyPayload(WALLET_ID, state);

    expect(payload).toMatchObject({
      walletId: WALLET_ID,
      destinationAllowlist: [ADDRESS_B],
      maxTransferAmount: "100",
      maxDailyAmount: "500",
      defaultAction: "review",
    });
    expect(payload.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "operation_family",
          families: ["transfer"],
          action: "deny",
        }),
        expect.objectContaining({
          kind: "operation_family",
          families: ["payment"],
          action: "approval_required",
        }),
        expect.objectContaining({
          kind: "operation_type",
          operationTypes: ["payment.create"],
          action: "review",
        }),
        expect.objectContaining({ kind: "asset", assets: [ADDRESS_A], action: "allow" }),
        expect.objectContaining({ kind: "destination", allowlist: [ADDRESS_B] }),
        expect.objectContaining({ kind: "amount", max: "100" }),
        expect.objectContaining({ kind: "approval", families: ["ramp"] }),
      ])
    );
  });

  it("disables controls by returning the wallet to default allow", () => {
    expect(buildDisabledPolicyPayload(WALLET_ID)).toEqual({
      walletId: WALLET_ID,
      destinationAllowlist: [],
      defaultAction: "allow",
      rules: [],
    });
  });

  it("uses the exact provider-partial label", () => {
    expect(formatProviderMappingLabel("partial", true)).toBe("Provider partially mapped");
    expect(formatProviderMappingLabel(null, false)).toBe("Not applicable");
  });

  it("loads existing policies into equivalent form state without dropping rule capabilities", () => {
    const existing: PaymentWalletPolicy = {
      walletId: WALLET_ID,
      destinationAllowlist: [],
      maxTransferAmount: "250",
      maxDailyAmount: "1000",
      defaultAction: "review",
      rules: [
        {
          id: "families",
          kind: "operation_family",
          families: ["transfer", "payment"],
          action: "deny",
        },
        {
          id: "types",
          kind: "operation_type",
          operationTypes: ["payment.create"],
          action: "review",
        },
        { id: "assets", kind: "asset", assets: [ADDRESS_A], action: "allow" },
        { id: "destinations", kind: "destination", blocklist: [ADDRESS_B] },
        {
          id: "asset-limit",
          kind: "amount",
          max: "50",
          assets: [ADDRESS_A],
          action: "deny",
        },
        { id: "approvals", kind: "approval", families: ["ramp"] },
        { id: "always-review", kind: "always", action: "review" },
      ],
    };

    const state = createPolicyAuthoringState(existing);
    const rebuilt = buildPolicyPayload(WALLET_ID, state);

    expect(state).toMatchObject({
      defaultAction: "review",
      maxTransferAmount: "250",
      maxDailyAmount: "1000",
      assets: [ADDRESS_A],
      destinationMode: "blocklist",
      destinationText: ADDRESS_B,
      familyActions: { transfer: "deny", payment: "deny" },
      operationTypeRules: [{ value: "payment.create", action: "review" }],
      approvalFamilies: ["ramp"],
    });
    expect(rebuilt.destinationAllowlist).toEqual([]);
    expect(rebuilt.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "asset-limit", kind: "amount", assets: [ADDRESS_A] }),
        expect.objectContaining({ id: "always-review", kind: "always", action: "review" }),
        expect.objectContaining({ kind: "destination", blocklist: [ADDRESS_B] }),
        expect.objectContaining({ kind: "approval", families: ["ramp"] }),
      ])
    );
  });

  it("preserves conflicting destination modes without merging their semantics", () => {
    const existing: PaymentWalletPolicy = {
      walletId: WALLET_ID,
      destinationAllowlist: [ADDRESS_A],
      rules: [
        {
          id: "allowed-destinations",
          kind: "destination",
          allowlist: [ADDRESS_A],
          action: "allow",
        },
        {
          id: "blocked-destinations",
          kind: "destination",
          blocklist: [ADDRESS_B],
          action: "deny",
        },
      ],
    };

    const rebuilt = buildPolicyPayload(WALLET_ID, createPolicyAuthoringState(existing));

    expect(rebuilt.destinationAllowlist).toEqual([ADDRESS_A]);
    expect(rebuilt.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "destination", allowlist: [ADDRESS_A], action: "allow" }),
        expect.objectContaining({
          id: "blocked-destinations",
          kind: "destination",
          blocklist: [ADDRESS_B],
          action: "deny",
        }),
      ])
    );
    expect(rebuilt.rules).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "destination", blocklist: [ADDRESS_A] }),
      ])
    );
  });
});
