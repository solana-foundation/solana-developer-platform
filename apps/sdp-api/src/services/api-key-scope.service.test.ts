import { API_KEY_FORBIDDEN_ACTIONS, API_KEY_GRANTABLE_ACTIONS } from "@sdp/types/actions";
import { describe, expect, it } from "vitest";
import { assertGrantableApiKeyGrants, parseRequestedWalletScope } from "./api-key-scope.service";

describe("parseRequestedWalletScope", () => {
  it("keeps an all-wallets key unlisted", () => {
    expect(
      parseRequestedWalletScope({
        walletScope: "all",
        walletIds: undefined,
      })
    ).toEqual({ scope: "all", walletIds: [] });
  });

  it("lists exactly the named wallets for a selected key", () => {
    expect(
      parseRequestedWalletScope({
        walletScope: "selected",
        walletIds: ["cwlt_a", "cwlt_b"],
      })
    ).toEqual({ scope: "selected", walletIds: ["cwlt_a", "cwlt_b"] });
  });

  it("keeps a selected key with no wallets selected: it signs nothing, never everything", () => {
    expect(
      parseRequestedWalletScope({
        walletScope: "selected",
        walletIds: undefined,
      })
    ).toEqual({ scope: "selected", walletIds: [] });
  });

  it("refuses wallets on an all-wallets key", () => {
    expect(() =>
      parseRequestedWalletScope({
        walletScope: "all",
        walletIds: ["cwlt_a"],
      })
    ).toThrowError(expect.objectContaining({ code: "BAD_REQUEST" }));
  });

  it("leaves the scope alone when an update names neither, and refuses wallets without a scope", () => {
    expect(
      parseRequestedWalletScope({
        walletScope: undefined,
        walletIds: undefined,
      })
    ).toBeUndefined();
    expect(() =>
      parseRequestedWalletScope({
        walletScope: undefined,
        walletIds: ["cwlt_a"],
      })
    ).toThrowError(expect.objectContaining({ code: "BAD_REQUEST" }));
  });
});

describe("assertGrantableApiKeyGrants", () => {
  it("lets an organization administrator grant every action a key may hold", () => {
    expect(() => assertGrantableApiKeyGrants("admin", API_KEY_GRANTABLE_ACTIONS)).not.toThrow();
  });

  it("refuses an action no API key may hold, naming it, even for an administrator", () => {
    for (const action of API_KEY_FORBIDDEN_ACTIONS) {
      expect(() => assertGrantableApiKeyGrants("admin", [action])).toThrowError(
        expect.objectContaining({ code: "BAD_REQUEST", details: { actions: [action] } })
      );
    }
  });

  it("refuses a grant beyond what the person's role holds", () => {
    expect(() => assertGrantableApiKeyGrants("member", ["issuance.enforce"])).toThrowError(
      expect.objectContaining({
        code: "INSUFFICIENT_PERMISSIONS",
        details: { actions: ["issuance.enforce"] },
      })
    );
  });

  it("allows a member to grant actions they hold, and an empty list", () => {
    expect(() =>
      assertGrantableApiKeyGrants("member", ["transfers.execute", "counterparties.read"])
    ).not.toThrow();
    expect(() => assertGrantableApiKeyGrants("member", [])).not.toThrow();
  });
});
