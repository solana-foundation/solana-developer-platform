import { API_KEY_FORBIDDEN_ACTIONS, API_KEY_GRANTABLE_ACTIONS } from "@sdp/types/actions";
import { SDP_RAMP_PROVIDER_MATURITY } from "@sdp/types/release-channels";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { providerMaturity } from "@/test/helpers/provider-maturity";
import {
  assertApiKeyGrantsInReleaseChannel,
  assertGrantableApiKeyGrants,
  parseRequestedWalletScope,
} from "./api-key-scope.service";

vi.mock("@sdp/types/release-channels", async (importOriginal) => {
  const { mockReleaseChannelMaturity } = await import("@/test/helpers/provider-maturity");
  const { RAMP_PROVIDERS } = await import("@sdp/types/provider-access");
  return mockReleaseChannelMaturity(
    await importOriginal<typeof import("@sdp/types/release-channels")>(),
    RAMP_PROVIDERS
  );
});

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

describe("assertApiKeyGrantsInReleaseChannel", () => {
  beforeEach(() => {
    providerMaturity.moduleEnvironmentMaturityOverride = null;
  });

  it("refuses a grant whose module the channel leaves out for the key's environment only", () => {
    providerMaturity.moduleEnvironmentMaturityOverride = {
      module: "payments",
      environment: "production",
      stage: "beta",
    };
    const stable = {
      releaseChannel: "stable",
      rampProviderMaturity: SDP_RAMP_PROVIDER_MATURITY,
    } as const;

    expect(() =>
      assertApiKeyGrantsInReleaseChannel({ ...stable, environment: "production" }, [
        "transfers.read",
      ])
    ).toThrowError(
      expect.objectContaining({
        code: "BAD_REQUEST",
        statusCode: 400,
        details: { actions: ["transfers.read"] },
      })
    );
    expect(() =>
      assertApiKeyGrantsInReleaseChannel({ ...stable, environment: "sandbox" }, ["transfers.read"])
    ).not.toThrow();
  });
});
