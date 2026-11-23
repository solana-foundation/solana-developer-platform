import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "@/test/helpers/env";
import { readPrivyWalletPolicy } from "./privy-policy";

describe("Privy wallet policy inspection", () => {
  afterEach(() => vi.restoreAllMocks());
  it.each([
    [[], "missing"],
    [["policy-1"], "present"],
  ] as const)("inspects attached policy ids %j", async (policy_ids, status) => {
    const read = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ id: "wallet-1", policy_ids }));
    expect(
      await readPrivyWalletPolicy(env, { appId: "app", appSecret: "secret" }, "privy_wallet-1")
    ).toMatchObject({ status });
    expect(read).toHaveBeenCalledOnce();
    expect(read.mock.calls[0]?.[0]).toBe("https://api.privy.io/v1/wallets/wallet-1");
    expect(read.mock.calls[0]?.[1]?.redirect).toBe("error");
  });
  it.each([401, 403, 404, 429, 500])("never calls HTTP %i a missing policy", async (status) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status }));
    expect(
      await readPrivyWalletPolicy(env, { appId: "app", appSecret: "secret" }, "privy_wallet-1")
    ).toMatchObject({ status: "unknown" });
  });
  it("reads Privy's rejected-credential 400 as access denied, as the credential check does", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ code: "missing_or_invalid_privy_app_id" }, { status: 400 })
    );
    expect(
      await readPrivyWalletPolicy(env, { appId: "app", appSecret: "secret" }, "privy_wallet-1")
    ).toEqual({ status: "unknown", reason: "access_denied" });
  });
  it("keeps a 400 body that names no rejected credential unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ code: "internal_error" }, { status: 400 })
    );
    expect(
      await readPrivyWalletPolicy(env, { appId: "app", appSecret: "secret" }, "privy_wallet-1")
    ).toEqual({ status: "unknown", reason: "provider_unavailable" });
  });
  it.each([
    { id: "wallet-1" },
    { id: "another-wallet", policy_ids: [] },
    { id: "wallet-1", policy_ids: null },
  ])("keeps malformed or mismatched evidence unknown", async (body) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body));
    expect(
      await readPrivyWalletPolicy(env, { appId: "app", appSecret: "secret" }, "privy_wallet-1")
    ).toEqual({ status: "unknown", reason: "unsupported_response" });
  });
  it("keeps timeouts unknown without exposing their contents", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("sensitive provider body"));
    expect(
      await readPrivyWalletPolicy(env, { appId: "app", appSecret: "secret" }, "privy_wallet-1")
    ).toEqual({ status: "unknown", reason: "provider_unavailable" });
  });
});
