import { describe, expect, it, vi } from "vitest";
import type { CustodyProvisioningRuntime } from "#/shared/runtime";
import { testRuntime } from "#/test/runtime";
import { readPrivyWalletPolicy } from "./policy";

const CREDENTIAL = { appId: "app", appSecret: "secret" };

function readAgainst(answer: () => Promise<Response>) {
  return readPrivyWalletPolicy(testRuntime(answer), CREDENTIAL, "privy_wallet-1");
}

describe("Privy wallet policy inspection", () => {
  it.each([
    [[], { status: "missing", reason: "no_policy" }],
    [["policy-1"], { status: "present", reason: "policy_detected" }],
  ] as const)("inspects attached policy ids %j", async (policy_ids, expected) => {
    const fetch = vi.fn<CustodyProvisioningRuntime["fetch"]>(async () =>
      Response.json({ id: "wallet-1", policy_ids })
    );
    expect(await readPrivyWalletPolicy(testRuntime(fetch), CREDENTIAL, "privy_wallet-1")).toEqual(
      expected
    );
    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "https://api.privy.io/v1/wallets/wallet-1",
      expect.objectContaining({ redirect: "error" })
    );
  });
  it.each([401, 403, 404, 429, 500])("never calls HTTP %i a missing policy", async (status) => {
    expect(await readAgainst(async () => new Response("", { status }))).toMatchObject({
      status: "unknown",
    });
  });
  it("reads Privy's rejected-credential 400 as access denied, as the credential check does", async () => {
    expect(
      await readAgainst(async () =>
        Response.json({ code: "missing_or_invalid_privy_app_id" }, { status: 400 })
      )
    ).toEqual({ status: "unknown", reason: "access_denied" });
  });
  it("keeps a 400 body that names no rejected credential unavailable", async () => {
    expect(
      await readAgainst(async () => Response.json({ code: "internal_error" }, { status: 400 }))
    ).toEqual({ status: "unknown", reason: "provider_unavailable" });
  });
  it.each([
    { id: "wallet-1" },
    { id: "another-wallet", policy_ids: [] },
    { id: "wallet-1", policy_ids: null },
  ])("keeps malformed or mismatched evidence unknown", async (body) => {
    expect(await readAgainst(async () => Response.json(body))).toEqual({
      status: "unknown",
      reason: "unsupported_response",
    });
  });
  it("keeps timeouts unknown without exposing their contents", async () => {
    expect(
      await readAgainst(async () => {
        throw new Error("sensitive provider body");
      })
    ).toEqual({ status: "unknown", reason: "provider_unavailable" });
  });
});
