import type { ApiKeyWalletPolicyBindingSummary } from "@sdp/types";
import { describe, expect, it } from "vitest";
import {
  type ApiKeyAuthoringDraft,
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

const WITH_POLICIES = { policiesInReleaseChannel: true };
const WITHOUT_POLICIES = { policiesInReleaseChannel: false };

describe("API-key authoring", () => {
  it("leaves the no-policy create flow unchanged", () => {
    const draft = createApiKeyAuthoringDraft();

    expect(buildApiKeyPolicyRules(draft)).toEqual([]);
    expect(getPolicyBindingIntent("create", null, draft, WITH_POLICIES)).toEqual({ mode: "none" });
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
    const draft: ApiKeyAuthoringDraft = {
      ...createApiKeyAuthoringDraft(),
      restrictionsEnabled: true,
      restrictionsEdited: true,
      operationFamilies: ["ramp", "issuance"],
      operationTypes: ["payment_transfer_execute", "issuance_mint_execute"],
      assets: "USDC\nSOL",
      maximumAmount: "2500",
      maximumAmountAssets: "USDC, SOL",
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
    expect(buildApiKeyPolicyRules(draft)[3]).toMatchObject({
      action: "allow",
      max: "2500",
      assets: ["USDC", "SOL"],
    });
    expect(buildApiKeyPolicyRules(draft)[4]).toMatchObject({
      action: "allow",
      allowlist: ["address_a", "address_b"],
    });
  });

  it("emits no amount rule when the maximum names no assets", () => {
    const draft = {
      ...createApiKeyAuthoringDraft(),
      restrictionsEnabled: true,
      restrictionsEdited: true,
      maximumAmount: "2500",
    };

    expect(buildApiKeyPolicyRules(draft)).toEqual([]);
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
    const replaceIntent = getPolicyBindingIntent("edit", initial, replacement, WITH_POLICIES);
    const clearIntent = getPolicyBindingIntent(
      "edit",
      initial,
      { ...replacement, restrictionsEnabled: false, restrictionsEdited: false },
      WITH_POLICIES
    );

    expect(requiredBindingConfirmation(replaceIntent)).toBe("replace");
    expect(replaceIntent).toMatchObject({
      mode: "replace",
      profile: "existing",
      existingProfileId: "profile_1",
    });
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

    expect(getPolicyBindingIntent("edit", initial, draft, WITH_POLICIES)).toEqual({ mode: "none" });
  });
});

describe("API-key policy bindings without the Policies module", () => {
  const restrictedKey = {
    walletScope: "selected" as const,
    selectedWalletIds: ["wallet_a"],
    policyBindings: [policyBinding()],
  };
  const unchangedDraft = {
    ...createApiKeyAuthoringDraft(),
    walletScope: "selected" as const,
    selectedWalletIds: ["wallet_a"],
    defaultWalletId: "wallet_a",
    restrictionsEnabled: true,
    restrictionsEdited: false,
  };
  const blocked = { mode: "blocked", reason: "policies_unavailable" };

  it("leaves an unchanged wallet scope alone, so only the key itself is saved", () => {
    expect(getPolicyBindingIntent("edit", restrictedKey, unchangedDraft, WITHOUT_POLICIES)).toEqual(
      { mode: "none" }
    );
    expect(
      getPolicyBindingIntent(
        "edit",
        { ...restrictedKey, policyBindings: [] },
        { ...unchangedDraft, walletScope: "all", restrictionsEnabled: false },
        WITHOUT_POLICIES
      )
    ).toEqual({ mode: "none" });
  });

  it("blocks a wallet-scope change on a key with bindings, where the API would refuse the rebind", () => {
    // With Policies the same edit rebinds the existing restrictions.
    const rescoped = { ...unchangedDraft, selectedWalletIds: ["wallet_a", "wallet_b"] };
    expect(getPolicyBindingIntent("edit", restrictedKey, rescoped, WITH_POLICIES)).toMatchObject({
      mode: "replace",
    });
    expect(getPolicyBindingIntent("edit", restrictedKey, rescoped, WITHOUT_POLICIES)).toEqual(
      blocked
    );
    expect(
      getPolicyBindingIntent(
        "edit",
        restrictedKey,
        { ...unchangedDraft, walletScope: "all" },
        WITHOUT_POLICIES
      )
    ).toEqual(blocked);
  });

  it("blocks adding, editing or clearing restrictions instead of calling the policy endpoints", () => {
    expect(
      getPolicyBindingIntent(
        "create",
        null,
        { ...createApiKeyAuthoringDraft(), restrictionsEnabled: true, restrictionsEdited: true },
        WITHOUT_POLICIES
      )
    ).toEqual(blocked);
    expect(
      getPolicyBindingIntent(
        "edit",
        restrictedKey,
        { ...unchangedDraft, restrictionsEdited: true },
        WITHOUT_POLICIES
      )
    ).toEqual(blocked);
    expect(
      getPolicyBindingIntent(
        "edit",
        restrictedKey,
        { ...unchangedDraft, restrictionsEnabled: false },
        WITHOUT_POLICIES
      )
    ).toEqual(blocked);
  });
});
