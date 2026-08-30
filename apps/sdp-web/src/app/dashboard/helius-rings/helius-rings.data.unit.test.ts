import { afterEach, describe, expect, it, vi } from "vitest";
import { createRingsWallet, fetchRingsWalletIdentity } from "./helius-rings.data";

/**
 * A provisioning failure's reason has to reach the operator intact: a 503 names
 * fixable conditions, so rewriting it as "awaiting integration" points them at
 * a wait that will never end.
 */

function respondWith(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status }))
  );
}

const INPUT = { walletId: "para_1", name: "Treasury" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createRingsWallet", () => {
  it("returns the wallet on success", async () => {
    respondWith(201, { data: { wallet: { id: "hrw_1", name: "Treasury" } } });

    const result = await createRingsWallet(INPUT);

    expect(result.wallet).toMatchObject({ id: "hrw_1" });
    expect(result.error).toBeUndefined();
  });

  it("passes a 503 reason through instead of rewriting it", async () => {
    const reason =
      "the Rings registration transaction could not be broadcast; confirm the wallet owner holds devnet SOL for the fee";
    respondWith(503, { error: { code: "SERVICE_UNAVAILABLE", message: reason } });

    const result = await createRingsWallet(INPUT);

    expect(result.error).toBe(reason);
    expect(result.wallet).toBeUndefined();
  });

  it("passes a non-503 reason through too", async () => {
    respondWith(400, {
      error: { code: "BAD_REQUEST", message: "custody does not control that key" },
    });

    await expect(createRingsWallet(INPUT)).resolves.toMatchObject({
      error: "custody does not control that key",
    });
  });

  // The caller substitutes its own copy, so this only has to stay a failure.
  it("reports a failure carrying no message as an undefined reason", async () => {
    respondWith(500, {});

    const result = await createRingsWallet(INPUT);

    expect(result.wallet).toBeUndefined();
    expect(result.error).toBeUndefined();
  });
});

describe("fetchRingsWalletIdentity", () => {
  const IDENTITY = {
    status: "foreign",
    derivedShieldedAddress: "rings1derived",
    publishedShieldedAddress: "rings1published",
    mismatch: "nullifier_key",
    recordedShieldedAddress: null,
  };

  it("reads the identity through the wallet's own BFF path", async () => {
    respondWith(200, { data: { identity: IDENTITY } });

    const result = await fetchRingsWalletIdentity("hrw_1/../health");

    expect(result.identity).toEqual(IDENTITY);
    // Encoded, so an id carrying path characters cannot reach another endpoint.
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      "/api/dashboard/helius-rings/wallets/hrw_1%2F..%2Fhealth/identity"
    );
  });

  it("passes the server's reason through instead of rewriting it", async () => {
    const reason = "Helius Rings is enabled but HELIUS_RINGS_RPC_URL is not configured";
    respondWith(503, { error: { code: "SERVICE_UNAVAILABLE", message: reason } });

    await expect(fetchRingsWalletIdentity("hrw_1")).resolves.toEqual({ error: reason });
  });

  it("reports a bodyless failure as a failure rather than an empty verdict", async () => {
    respondWith(500, {});

    const result = await fetchRingsWalletIdentity("hrw_1");

    expect(result.identity).toBeUndefined();
    expect(result.error).toBeUndefined();
  });
});
