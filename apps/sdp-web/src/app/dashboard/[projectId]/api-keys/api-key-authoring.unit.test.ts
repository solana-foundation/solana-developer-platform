import { type Action, API_KEY_GRANTABLE_ACTIONS, grantsCoverAction } from "@sdp/types/actions";
import {
  isModuleInReleaseChannel,
  SDP_RAMP_PROVIDER_STAGES,
  type SdpModule,
} from "@sdp/types/release-channels";
import { describe, expect, it } from "vitest";
import {
  type ApiKeyAuthoringDraft,
  buildEndpointWalletPayload,
  clearModuleGrants,
  clearOfferedGrants,
  createApiKeyAuthoringDraft,
  defaultWalletScopeForGrants,
  everythingGrants,
  grantableActionsInChannel,
  grantModuleRows,
  grantToggleState,
  heldGrantsNotOffered,
  summarizeGrants,
  toggleGrant,
} from "./api-key-authoring";

function draftWith(overrides: Partial<ApiKeyAuthoringDraft>): ApiKeyAuthoringDraft {
  return { ...createApiKeyAuthoringDraft(), ...overrides };
}

describe("API-key authoring: wallet access", () => {
  it("sends a selected key's custody wallet ids, and none for all wallets", () => {
    const selected = draftWith({
      walletScope: "selected",
      selectedWalletIds: ["cwlt_a", "cwlt_b", "cwlt_a"],
    });

    expect(buildEndpointWalletPayload(selected)).toEqual({
      walletScope: "selected",
      walletIds: ["cwlt_a", "cwlt_b"],
    });
    expect(buildEndpointWalletPayload({ ...selected, walletScope: "all" })).toEqual({
      walletScope: "all",
    });
  });

  it("starts a key that can execute on selected wallets, and a read-only key on all", () => {
    expect(defaultWalletScopeForGrants(["transfers.read", "transfers.execute"])).toBe("selected");
    expect(defaultWalletScopeForGrants(["transfers.read", "recurring.manage"])).toBe("all");
    expect(defaultWalletScopeForGrants([])).toBe("all");
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
      "projects",
      "organizations",
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

  it("narrows to read when a module's last write is turned off, and clears a module", () => {
    expect(toggleGrant(["transfers.execute"], "transfers.execute")).toEqual(["transfers.read"]);
    expect(toggleGrant(["recurring.manage", "recurring.execute"], "recurring.execute")).toEqual([
      "recurring.manage",
    ]);
    expect(toggleGrant(["transfers.read"], "transfers.read")).toEqual([]);
    expect(
      clearModuleGrants(["transfers.execute", "wallets.read", "transfers.read"], "transfers")
    ).toEqual(["wallets.read"]);
  });

  it("keeps a read set before a write was ticked and unticked", () => {
    const ticked = toggleGrant(["transfers.read"], "transfers.execute");
    expect(ticked).toEqual(["transfers.execute"]);
    expect(toggleGrant(ticked, "transfers.execute")).toEqual(["transfers.read"]);
  });

  it("keeps a read next to verbs that include nothing (issuance enforce, authority)", () => {
    const grants = toggleGrant(
      toggleGrant(["issuance.read"], "issuance.enforce"),
      "issuance.authority"
    );
    expect(grants).toEqual(["issuance.read", "issuance.enforce", "issuance.authority"]);
    expect(grantToggleState(grants, "issuance.read")).toBe("on");
    expect(toggleGrant(["issuance.enforce"], "issuance.read")).toEqual([
      "issuance.read",
      "issuance.enforce",
    ]);
    expect(toggleGrant(grants, "issuance.enforce")).toEqual([
      "issuance.read",
      "issuance.authority",
    ]);
    expect(toggleGrant(["issuance.enforce"], "issuance.enforce")).toEqual([]);
  });

  it("writes Everything out as the explicit offered list", () => {
    const offered = grantableActionsInChannel(inStable);
    const everything = everythingGrants(offered);
    for (const action of offered) {
      expect(grantsCoverAction(everything, action), action).toBe(true);
    }
  });

  it("stores no read that Everything's manage or execute already includes", () => {
    const everything = everythingGrants(grantableActionsInChannel(inStable));
    expect(everything).toContain("transfers.execute");
    expect(everything).not.toContain("transfers.read");
    expect(everything).toContain("transactions.read");
  });

  it("keeps held grants the channel does not offer through Everything and Clear all", () => {
    const offered = grantableActionsInChannel(inStable);
    expect(offered).not.toContain("issuance.execute");
    const held: Action[] = ["issuance.execute", "transfers.read"];
    expect(heldGrantsNotOffered(held, offered)).toEqual(["issuance.execute"]);
    expect(everythingGrants(offered, held)).toContain("issuance.execute");
    expect(clearOfferedGrants(held, offered)).toEqual(["issuance.execute"]);
  });

  it("summarizes held verbs by module, the included read listed", () => {
    expect(summarizeGrants(["transfers.execute", "wallets.read"])).toEqual([
      { module: "transfers", verbs: ["read", "execute"] },
      { module: "wallets", verbs: ["read"] },
    ]);
  });
});
