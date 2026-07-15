import type { ApiKeyWalletPolicyBindingSummary, WalletOperationFamily } from "@sdp/types";
import { describe, expect, it } from "vitest";
import {
  buildApiKeyPolicyRules,
  buildEndpointWalletPayload,
  buildPolicyBindingTargets,
  createApiKeyAuthoringDraft,
  getPolicyBindingIntent,
  requiredBindingConfirmation,
} from "./api-key-authoring";

function policyBinding(
  overrides: Partial<ApiKeyWalletPolicyBindingSummary> = {}
): ApiKeyWalletPolicyBindingSummary {
  return {
    id: "binding_1",
    bindingScope: "selected",
    walletId: "wallet_a",
    custodyWalletId: "custody_wallet_a",
    walletControlProfileId: null,
    walletControlProfileRevisionId: null,
    apiKeyControlProfileId: "profile_1",
    apiKeyControlProfileRevisionId: "revision_1",
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    ...overrides,
  };
}

describe("API-key authoring", () => {
  it("leaves the no-policy create flow unchanged", () => {
    const draft = createApiKeyAuthoringDraft();

    expect(buildApiKeyPolicyRules(draft)).toEqual([]);
    expect(getPolicyBindingIntent("create", null, draft)).toEqual({ mode: "none" });
  });

  it("builds selected-wallet and all-wallet endpoint scope", () => {
    const selected = {
      ...createApiKeyAuthoringDraft(),
      walletScope: "selected" as const,
      selectedWalletIds: ["wallet_a", "wallet_b"],
      defaultWalletId: "wallet_b",
    };

    expect(buildEndpointWalletPayload(selected)).toEqual({
      walletScope: "selected",
      signingWalletId: "wallet_b",
      signingWalletIds: ["wallet_a", "wallet_b"],
    });
    expect(buildEndpointWalletPayload({ ...selected, walletScope: "all" })).toEqual({
      walletScope: "all",
    });
  });

  it("authors every additional restriction section as narrowing rules", () => {
    const draft = {
      ...createApiKeyAuthoringDraft(),
      restrictionsEnabled: true,
      restrictionsEdited: true,
      operationFamilies: ["raw_sign", "provider_admin"] as WalletOperationFamily[],
      operationTypes: "payment_transfer_execute, token_mint",
      assets: "USDC\nSOL",
      maximumAmount: "2500",
      destinations: "address_a,address_b",
      approvalRequired: true,
    };

    expect(buildApiKeyPolicyRules(draft).map((rule) => rule.kind)).toEqual([
      "operation_family",
      "operation_type",
      "asset",
      "amount",
      "destination",
      "approval",
    ]);
    expect(buildApiKeyPolicyRules(draft)[0]).toMatchObject({ action: "deny" });
    expect(buildApiKeyPolicyRules(draft)[4]).toMatchObject({
      action: "allow",
      allowlist: ["address_a", "address_b"],
    });
  });

  it("builds bindings for selected-wallet and all-wallet restrictions", () => {
    const selected = {
      ...createApiKeyAuthoringDraft(),
      walletScope: "selected" as const,
      selectedWalletIds: ["wallet_a", "wallet_b"],
    };

    expect(buildPolicyBindingTargets(selected, "profile_1")).toEqual([
      {
        bindingScope: "selected",
        walletId: "wallet_a",
        apiKeyControlProfileId: "profile_1",
      },
      {
        bindingScope: "selected",
        walletId: "wallet_b",
        apiKeyControlProfileId: "profile_1",
      },
    ]);
    expect(buildPolicyBindingTargets({ ...selected, walletScope: "all" }, "profile_1")).toEqual([
      { bindingScope: "all", apiKeyControlProfileId: "profile_1" },
    ]);
  });

  it("requires explicit replace and clear confirmations for existing bindings", () => {
    const initial = {
      walletScope: "selected" as const,
      selectedWalletIds: ["wallet_a"],
      policyBindings: [policyBinding()],
    };
    const replacement = {
      ...createApiKeyAuthoringDraft(),
      walletScope: "selected" as const,
      selectedWalletIds: ["wallet_a"],
      defaultWalletId: "wallet_a",
      restrictionsEnabled: true,
      restrictionsEdited: true,
    };
    const replaceIntent = getPolicyBindingIntent("edit", initial, replacement);
    const clearIntent = getPolicyBindingIntent("edit", initial, {
      ...replacement,
      restrictionsEnabled: false,
      restrictionsEdited: false,
    });

    expect(requiredBindingConfirmation(replaceIntent)).toBe("replace");
    expect(requiredBindingConfirmation(clearIntent)).toBe("clear");
  });

  it("preserves existing policy bindings when the key is unchanged", () => {
    const initial = {
      walletScope: "selected" as const,
      selectedWalletIds: ["wallet_a"],
      policyBindings: [policyBinding()],
    };
    const draft = {
      ...createApiKeyAuthoringDraft(),
      walletScope: "selected" as const,
      selectedWalletIds: ["wallet_a"],
      defaultWalletId: "wallet_a",
      restrictionsEnabled: true,
      restrictionsEdited: false,
    };

    expect(getPolicyBindingIntent("edit", initial, draft)).toEqual({ mode: "none" });
  });
});
