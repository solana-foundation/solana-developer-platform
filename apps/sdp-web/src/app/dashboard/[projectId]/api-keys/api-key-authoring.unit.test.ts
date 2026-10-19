import {
  type AllowedOperation,
  OPERATION_TYPES,
  operationTypesInFamily,
} from "@sdp/types/allowed-operations";
import { describe, expect, it } from "vitest";
import {
  type ApiKeyAuthoringDraft,
  buildAllowedOperations,
  buildEndpointWalletPayload,
  createApiKeyAuthoringDraft,
  familyState,
  isOperationTypeTicked,
  summarizeAllowedOperations,
  toggleFamily,
  toggleOperationType,
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

describe("API-key authoring: allowed operations", () => {
  it("starts unrestricted and sends no list", () => {
    const draft = createApiKeyAuthoringDraft();

    expect(draft.operationsScope).toBe("all");
    expect(buildAllowedOperations(draft)).toEqual([]);
  });

  it("ignores ticked operations while the key is unrestricted", () => {
    const draft = draftWith({ operationsScope: "all", selectedOperations: ["payment"] });

    expect(buildAllowedOperations(draft)).toEqual([]);
  });

  it("sends the ticked operations, sorted and without duplicates", () => {
    const draft = draftWith({
      operationsScope: "selected",
      selectedOperations: ["ramp", "payment", "ramp", "issuance_mint_execute"],
    });

    expect(buildAllowedOperations(draft)).toEqual(["issuance_mint_execute", "payment", "ramp"]);
  });

  it("ticks a whole family, and clears it again", () => {
    const ticked = toggleFamily([], "payment");

    expect(ticked).toEqual(["payment"]);
    expect(familyState(ticked, "payment")).toBe("all");
    expect(toggleFamily(ticked, "payment")).toEqual([]);
  });

  it("ticks the whole family when it is partly ticked", () => {
    const partial = toggleOperationType([], "payment_transfer_execute");

    expect(familyState(partial, "payment")).toBe("some");
    expect(toggleFamily(partial, "payment")).toEqual(["payment"]);
  });

  it("clears every type under a fully ticked family", () => {
    const types = operationTypesInFamily("ramp");
    expect(familyState(types, "ramp")).toBe("all");
    expect(toggleFamily(types, "ramp")).toEqual([]);
  });

  it("keeps an unknown stored value when a family is toggled", () => {
    const stored = ["gone_op"] as unknown as AllowedOperation[];

    expect(toggleFamily(stored, "ramp")).toEqual(["gone_op", "ramp"]);
  });

  it("turns a ticked family into its remaining types when one type is unticked", () => {
    const result = toggleOperationType(["ramp"], "ramp_onramp_quote");

    expect(result).toEqual(["ramp_offramp_quote"]);
    expect(familyState(result, "ramp")).toBe("some");
    expect(isOperationTypeTicked(result, "ramp_onramp_quote")).toBe(false);
    expect(isOperationTypeTicked(result, "ramp_offramp_quote")).toBe(true);
  });

  it("stores a fully ticked family as the family, not as its types", () => {
    const types = operationTypesInFamily("ramp");
    let selected = toggleOperationType([], types[0]);
    for (const type of types.slice(1)) {
      selected = toggleOperationType(selected, type);
    }

    expect(selected).toEqual(["ramp"]);
  });

  it("keeps the ticks of other families when one family changes", () => {
    const selected = toggleOperationType(["issuance_mint_execute", "payment"], "ramp_onramp_quote");

    expect(selected).toEqual(["issuance_mint_execute", "payment", "ramp_onramp_quote"]);
    expect(toggleFamily(selected, "payment")).toEqual([
      "issuance_mint_execute",
      "ramp_onramp_quote",
    ]);
  });

  it("reports every operation type as ticked under a ticked family", () => {
    for (const type of OPERATION_TYPES) {
      const family = operationTypesInFamily("payment").includes(type as never) ? "payment" : null;
      if (family) {
        expect(isOperationTypeTicked(["payment"], type)).toBe(true);
      } else {
        expect(isOperationTypeTicked(["payment"], type)).toBe(false);
      }
    }
  });
});

describe("API-key authoring: summary", () => {
  it("names an unrestricted key", () => {
    expect(summarizeAllowedOperations([])).toEqual({
      kind: "unrestricted",
      families: [],
      typeCount: 0,
    });
  });

  it("lists ticked families in the vocabulary's order", () => {
    expect(summarizeAllowedOperations(["ramp", "payment"])).toEqual({
      kind: "families",
      families: ["payment", "ramp"],
      typeCount: 0,
    });
  });

  it("counts specific actions next to whole families", () => {
    expect(summarizeAllowedOperations(["payment", "issuance_mint_execute", "dvp_fund"])).toEqual({
      kind: "mixed",
      families: ["payment"],
      typeCount: 2,
    });
  });
});
