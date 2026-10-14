import {
  API_KEY_GRANTABLE_ACTIONS,
  isModuleInReleaseChannel,
  SDP_RAMP_PROVIDER_STAGES,
  type SdpModule,
} from "@sdp/types";
import { describe, expect, it } from "vitest";
import {
  type ApiKeyAuthoringDraft,
  buildEndpointWalletPayload,
  clearModuleGrants,
  createApiKeyAuthoringDraft,
  everythingGrants,
  grantableActionsInChannel,
  grantModuleRows,
  grantToggleState,
  summarizeGrants,
  toggleGrant,
} from "./api-key-authoring";

function draftWith(overrides: Partial<ApiKeyAuthoringDraft>): ApiKeyAuthoringDraft {
  return { ...createApiKeyAuthoringDraft(), ...overrides };
}

describe("API-key authoring: wallet access", () => {
  it("builds selected-wallet and all-wallet endpoint scope", () => {
    const selected = draftWith({
      walletScope: "selected",
      selectedWalletIds: ["wallet_a", "wallet_b"],
      defaultWalletId: "wallet_b",
    });

    expect(buildEndpointWalletPayload(selected)).toEqual({
      walletScope: "selected",
      signingWalletId: "wallet_b",
      signingWalletIds: ["wallet_a", "wallet_b"],
    });
    expect(buildEndpointWalletPayload({ ...selected, walletScope: "all" })).toEqual({
      walletScope: "all",
    });
  });

  it("falls back to the first selected wallet when the default is not selected", () => {
    const draft = draftWith({
      walletScope: "selected",
      selectedWalletIds: ["wallet_a", "wallet_b"],
      defaultWalletId: "wallet_z",
    });

    expect(buildEndpointWalletPayload(draft).signingWalletId).toBe("wallet_a");
  });
});

const inStable = (module: SdpModule) =>
  isModuleInReleaseChannel("stable", module, SDP_RAMP_PROVIDER_STAGES);
const inExperimental = (module: SdpModule) =>
  isModuleInReleaseChannel("experimental", module, SDP_RAMP_PROVIDER_STAGES);

describe("API-key authoring: grants offered by the release channel", () => {
  it("offers only stable modules and core on a stable deployment", () => {
    const offered = grantableActionsInChannel(inStable);
    expect(grantModuleRows(offered).map((row) => row.module)).toEqual([
      "transfers",
      "transfer_batches",
      "payment_requests",
      "counterparties",
      "transactions",
      "recurring",
      "wallets",
      "compliance",
      "projects",
      "organizations",
      "rpc",
    ]);
    // A counterparty's payout destination is a stable payments route; the
    // ramp requirements route is gated by its own mount, not by this action.
    expect(offered).toContain("counterparties.execute");
    expect(offered).not.toContain("issuance.read");
  });

  it("offers every grantable action on an experimental deployment", () => {
    expect(grantableActionsInChannel(inExperimental)).toEqual([...API_KEY_GRANTABLE_ACTIONS]);
  });

  it("never offers an action no key may hold", () => {
    const offered = grantableActionsInChannel(inExperimental);
    expect(offered.some((action) => action.endsWith(".configure"))).toBe(false);
    expect(offered.some((action) => action.startsWith("api_keys."))).toBe(false);
    expect(offered).not.toContain("organizations.manage");
  });
});

describe("API-key authoring: grant toggles", () => {
  it("stores manage or execute without the read they include, and shows read as included", () => {
    const grants = toggleGrant(["recurring.read"], "recurring.execute");
    expect(grants).toEqual(["recurring.execute"]);
    expect(grantToggleState(grants, "recurring.read")).toBe("implied");
    expect(grantToggleState(grants, "recurring.manage")).toBe("off");
  });

  it("holds manage and execute on one module together", () => {
    const grants = toggleGrant(toggleGrant([], "recurring.manage"), "recurring.execute");
    expect(grants).toEqual(["recurring.manage", "recurring.execute"]);
  });

  it("turns a verb off, and clears a module", () => {
    expect(toggleGrant(["transfers.execute"], "transfers.execute")).toEqual([]);
    expect(
      clearModuleGrants(["transfers.execute", "wallets.read", "transfers.read"], "transfers")
    ).toEqual(["wallets.read"]);
  });

  it("writes Everything out as the explicit offered list", () => {
    const offered = grantableActionsInChannel(inStable);
    expect(everythingGrants(offered)).toEqual(offered);
  });

  it("summarizes held verbs by module, the included read listed", () => {
    expect(summarizeGrants(["transfers.execute", "wallets.read"])).toEqual([
      { module: "transfers", verbs: ["read", "execute"] },
      { module: "wallets", verbs: ["read"] },
    ]);
  });
});
