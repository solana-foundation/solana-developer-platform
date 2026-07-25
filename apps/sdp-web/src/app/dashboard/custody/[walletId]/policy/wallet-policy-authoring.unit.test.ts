import type { PaymentWalletPolicy } from "@sdp/types";
import { describe, expect, it } from "vitest";
import {
  buildDisabledPolicyPayload,
  buildPolicyAssetOptions,
  buildPolicyPayload,
  createPolicyAuthoringState,
  formatProviderMappingLabel,
  hasLimitsAndAssetsControls,
  loadPolicyDraft,
  parseDestinationText,
  policyDraftStorageKey,
  type StoredPolicyDraft,
  SUPPORTED_WALLET_OPERATION_TYPES,
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
  it("exposes the supported operation types used by policy authoring", () => {
    expect(SUPPORTED_WALLET_OPERATION_TYPES).toEqual([
      { value: "payment_transfer_execute", family: "payment" },
      { value: "payment_transfer_batch_execute", family: "payment" },
      { value: "ramp_onramp_quote", family: "ramp" },
      { value: "ramp_offramp_quote", family: "ramp" },
      { value: "issuance_mint_execute", family: "issuance" },
      { value: "issuance_update_authority_execute", family: "issuance" },
      { value: "custody_signer_check", family: "raw_sign" },
    ]);
  });

  it("identifies whether the limits and assets step has selected controls", () => {
    const state = createPolicyAuthoringState(emptyPolicy());
    expect(hasLimitsAndAssetsControls(state)).toBe(false);

    state.categories = ["limits"];
    expect(hasLimitsAndAssetsControls(state)).toBe(true);

    state.categories = ["assets"];
    expect(hasLimitsAndAssetsControls(state)).toBe(true);
  });

  it("validates restriction intent, decimal values, and the daily limit relationship", () => {
    const state = createPolicyAuthoringState(emptyPolicy());
    expect(validatePolicyState(state).intent).toBe("restriction_required");

    state.categories = ["limits"];
    state.maxTransferAmount = "10.25";
    state.maxDailyAmount = "10.24";
    expect(validatePolicyState(state).maxDailyAmount).toBe("daily_below_transaction");

    state.maxTransferAmount = "1.2.3";
    expect(validatePolicyState(state).maxTransferAmount).toBe("invalid_decimal");

    state.maxTransferAmount = "100";
    state.maxDailyAmount = "000";
    expect(validatePolicyState(state).maxDailyAmount).toBe("invalid_decimal");

    state.maxDailyAmount = "0.00";
    expect(validatePolicyState(state).maxDailyAmount).toBe("invalid_decimal");

    state.maxTransferAmount = "0.5";
    state.maxDailyAmount = "0.75";
    expect(validatePolicyState(state).maxDailyAmount).toBeUndefined();

    state.maxDailyAmount = "0.49";
    expect(validatePolicyState(state).maxDailyAmount).toBe("daily_below_transaction");

    state.maxTransferAmount = "10";
    state.maxDailyAmount = "5.50";
    expect(validatePolicyState(state).maxDailyAmount).toBe("daily_below_transaction");
  });

  it("parses comma-separated destinations, de-duplicates, and reports invalid entries", () => {
    const parsed = parseDestinationText(`  ${ADDRESS_B}, ${ADDRESS_A}, ${ADDRESS_B}, not-a-wallet`);

    expect(parsed.valid).toEqual([ADDRESS_B, ADDRESS_A]);
    expect(parsed.entries[2]).toMatchObject({
      value: ADDRESS_B,
      duplicate: true,
      position: 3,
    });
    expect(parsed.invalid).toEqual([
      expect.objectContaining({ value: "not-a-wallet", position: 4, valid: false }),
    ]);
  });

  it("accepts pasted newline-separated destination lists", () => {
    expect(parseDestinationText(`${ADDRESS_A}\n${ADDRESS_B}`).valid).toEqual([
      ADDRESS_A,
      ADDRESS_B,
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
    state.defaultAction = "approval_required";
    state.categories = ["limits", "assets", "destinations", "operations"];
    state.maxTransferAmount = "100";
    state.maxDailyAmount = "500";
    state.assets = [ADDRESS_A];
    state.destinationMode = "allowlist";
    state.destinationText = ADDRESS_B;
    state.familyActions = { transfer: "deny", payment: "approval_required" };
    state.operationTypeRules = [{ value: "payment.create", action: "approval_required" }];

    const payload = buildPolicyPayload(WALLET_ID, state);

    expect(payload).toMatchObject({
      walletId: WALLET_ID,
      destinationAllowlist: [ADDRESS_B],
      maxTransferAmount: "100",
      maxDailyAmount: "500",
      defaultAction: "approval_required",
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
          action: "approval_required",
        }),
        expect.objectContaining({ kind: "asset", assets: [ADDRESS_A], action: "allow" }),
        expect.objectContaining({ kind: "destination", allowlist: [ADDRESS_B] }),
        expect.objectContaining({ kind: "amount", max: "100" }),
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
      defaultAction: "approval_required",
      maxTransferAmount: "250",
      maxDailyAmount: "1000",
      assets: [ADDRESS_A],
      destinationMode: "blocklist",
      destinationText: ADDRESS_B,
      familyActions: { transfer: "deny", payment: "deny", ramp: "approval_required" },
      operationTypeRules: [{ value: "payment.create", action: "approval_required" }],
    });
    expect(rebuilt.destinationAllowlist).toEqual([]);
    expect(rebuilt.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "asset-limit", kind: "amount", assets: [ADDRESS_A] }),
        expect.objectContaining({ id: "always-review", kind: "always", action: "review" }),
        expect.objectContaining({ kind: "destination", blocklist: [ADDRESS_B] }),
        expect.objectContaining({
          kind: "operation_family",
          families: ["ramp"],
          action: "approval_required",
        }),
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

describe("buildPolicyAssetOptions", () => {
  const SOL_HOLDING = {
    token: "SOL",
    mint: "So11111111111111111111111111111111111111112",
    uiAmount: "1.5",
  };

  it("offers well-known mints the wallet does not hold", () => {
    const options = buildPolicyAssetOptions([SOL_HOLDING], "sandbox");
    const symbols = options.map((option) => option.token);

    expect(symbols).toContain("USDC");
    expect(symbols).toContain("PYUSD");
  });

  it("keeps the wallet holding rather than duplicating its well-known entry", () => {
    const options = buildPolicyAssetOptions([SOL_HOLDING], "sandbox");
    const solEntries = options.filter((option) => option.mint === SOL_HOLDING.mint);

    expect(solEntries).toHaveLength(1);
    expect(solEntries[0]).toMatchObject({ source: "wallet", uiAmount: "1.5" });
  });

  it("lists wallet holdings before well-known suggestions", () => {
    const options = buildPolicyAssetOptions([SOL_HOLDING], "sandbox");

    expect(options[0]?.source).toBe("wallet");
    expect(options.at(-1)?.source).toBe("well-known");
  });

  it("omits tokens that have no mint on the active cluster", () => {
    // USDT ships a mainnet mint only, so sandbox must not offer it.
    expect(buildPolicyAssetOptions([], "sandbox").map((o) => o.token)).not.toContain("USDT");
    expect(buildPolicyAssetOptions([], "production").map((o) => o.token)).toContain("USDT");
  });

  it("resolves production mints for production projects", () => {
    const usdc = buildPolicyAssetOptions([], "production").find((o) => o.token === "USDC");

    expect(usdc?.mint).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  });

  it("dedupes repeated wallet holdings", () => {
    const options = buildPolicyAssetOptions([SOL_HOLDING, SOL_HOLDING], "sandbox");

    expect(options.filter((option) => option.mint === SOL_HOLDING.mint)).toHaveLength(1);
  });

  it("offers the tokens that are genuinely deployed on devnet", () => {
    const symbols = buildPolicyAssetOptions([], "sandbox").map((option) => option.token);

    expect(symbols).toContain("EURC");
    expect(symbols).toContain("JitoSOL");
    expect(symbols).toContain("mSOL");
    expect(symbols).toContain("bSOL");
  });

  it("withholds tokens whose devnet address is not the same asset", () => {
    const symbols = buildPolicyAssetOptions([], "sandbox").map((option) => option.token);

    // An account exists at the USDS address on devnet, but it is a different
    // mint with 9 decimals; offering it would misscale every amount.
    expect(symbols).not.toContain("USDS");
    // These resolve to System Program accounts on devnet rather than mints.
    expect(symbols).not.toContain("cbBTC");
    expect(symbols).not.toContain("INF");
  });

  it("carries the catalogue name and category through to the picker", () => {
    const usdc = buildPolicyAssetOptions([], "production").find(
      (option) => option.token === "USDC"
    );

    expect(usdc).toMatchObject({ name: "USD Coin", category: "stablecoin" });
  });

  it("labels staked SOL and wrapped assets by category on mainnet", () => {
    const options = buildPolicyAssetOptions([], "production");

    expect(options.find((o) => o.token === "JitoSOL")?.category).toBe("staked-sol");
    expect(options.find((o) => o.token === "cbBTC")?.category).toBe("wrapped");
  });
});
