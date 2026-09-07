import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProjectRing,
  createRingsWallet,
  executeRingsOperation,
  fetchProjectRings,
  fetchRingsHealth,
  fetchRingsOperationDetail,
  fetchRingsOperations,
  fetchRingsWalletIdentity,
  fetchRingsWallets,
  prepareRingsOperation,
  retryRingsOperation,
  syncRingsWallet,
  voidRingsOperation,
} from "./helius-rings.data";

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

const RING = {
  id: "hrr_1",
  name: "treasury",
  ringProgramId: "RingProgram1111111111111111111111111111111",
  status: "active",
  auditorPublicKeyHex: "04ff",
  lookupTableAddress: "LookupTab1e11111111111111111111111111111111",
  failure: null,
  createdAt: "2026-08-26T12:00:00.000Z",
  updatedAt: "2026-08-26T12:00:00.000Z",
};

describe("project rings", () => {
  it("reads the project's rings as a list", async () => {
    respondWith(200, { data: { rings: [RING] } });

    await expect(fetchProjectRings("unused")).resolves.toEqual({ rings: [RING] });
  });

  // A project with no custom ring is the normal case, not an error.
  it("reads no rings as an empty list", async () => {
    respondWith(200, { data: { rings: [] } });

    await expect(fetchProjectRings("unused")).resolves.toEqual({ rings: [] });
  });

  it("throws the server's own reason, and the caller's copy when it gave none", async () => {
    respondWith(503, { error: { message: "a Rings upstream service is unavailable" } });
    await expect(fetchProjectRings("fallback")).rejects.toThrow(
      "a Rings upstream service is unavailable"
    );

    respondWith(500, {});
    await expect(fetchProjectRings("fallback")).rejects.toThrow("fallback");
  });

  it("records a named ring and returns it", async () => {
    respondWith(201, { data: { ring: RING } });

    const result = await createProjectRing({
      name: "treasury",
      ringProgramId: RING.ringProgramId,
    });

    expect(result.ring).toEqual(RING);
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe("/api/dashboard/helius-rings/rings");
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body))).toEqual({
      name: "treasury",
      ringProgramId: RING.ringProgramId,
    });
  });

  // Bring-up names what refused (a bad id, a missing signer); the card prints it verbatim.
  it("returns the refusal reason rather than throwing", async () => {
    respondWith(409, { error: { message: "that ring program is already recorded" } });

    await expect(
      createProjectRing({ name: "payroll", ringProgramId: RING.ringProgramId })
    ).resolves.toEqual({ error: "that ring program is already recorded" });
  });
});

describe("operations", () => {
  const OPERATION = { id: "hro_1", state: "preparing" };

  it("sends the ring name and a fresh nonce when preparing", async () => {
    respondWith(201, { data: { operation: OPERATION } });

    const result = await prepareRingsOperation({
      walletId: "hrw_1",
      opType: "withdraw",
      asset: { mint: "So11111111111111111111111111111111111111112", amountRaw: "1000" },
      to: "9xQe",
      ring: "treasury",
    });

    expect(result.operation).toEqual(OPERATION);
    const body = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({ opType: "withdraw", ring: "treasury", to: "9xQe" });
    // The server dedupes on it, so a prepare that carried no nonce would let a
    // double-click file two operations.
    expect(body.clientNonce).toEqual(expect.any(String));
  });

  it("returns the server's refusal instead of throwing", async () => {
    respondWith(400, { error: { message: 'no ring named "nope"' } });

    await expect(
      prepareRingsOperation({
        walletId: "hrw_1",
        opType: "shield",
        asset: { mint: "So11111111111111111111111111111111111111112", amountRaw: "1" },
      })
    ).resolves.toEqual({ error: 'no ring named "nope"' });
  });

  it("executes and retries by id, and sends a body only where one is due", async () => {
    respondWith(200, { data: { operation: OPERATION } });
    await expect(executeRingsOperation("hro_1")).resolves.toEqual({ operation: OPERATION });
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      "/api/dashboard/helius-rings/operations/hro_1/execute"
    );
    // The approval verdict is read server-side, so execute carries nothing.
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.body).toBeUndefined();

    respondWith(201, { data: { operation: OPERATION } });
    await expect(retryRingsOperation("hro_1")).resolves.toEqual({ operation: OPERATION });
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body)).clientNonce).toEqual(
      expect.any(String)
    );
  });

  it("voids with the signature the operator reconciled", async () => {
    respondWith(200, { data: { operation: OPERATION } });

    await voidRingsOperation("hro_1", "5aWSV3n8");

    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body))).toEqual({
      signature: "5aWSV3n8",
    });
  });

  it("reads the list and one operation, encoding the id into its own path", async () => {
    respondWith(200, { data: { operations: [OPERATION] } });
    await expect(fetchRingsOperations("unused")).resolves.toEqual({ operations: [OPERATION] });

    respondWith(200, { data: { operation: OPERATION } });
    await fetchRingsOperationDetail("hro_1/../wallets", "unused");
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      "/api/dashboard/helius-rings/operations/hro_1%2F..%2Fwallets"
    );
  });
});

describe("workspace reads", () => {
  it("reads health and wallets, and throws the caller's copy on a bodyless failure", async () => {
    respondWith(200, { data: { health: { rpc: "green", prover: "green", photon: "amber" } } });
    await expect(fetchRingsHealth("unused")).resolves.toMatchObject({
      health: { photon: "amber" },
    });

    respondWith(200, { data: { wallets: [] } });
    await expect(fetchRingsWallets("unused")).resolves.toEqual({ wallets: [] });

    respondWith(500, {});
    await expect(fetchRingsWallets("could not load")).rejects.toThrow("could not load");
  });

  it("syncs a wallet by its own encoded path and passes a refusal back", async () => {
    respondWith(200, { data: { balances: [], degraded: false, observedAt: "2026-08-26" } });

    const result = await syncRingsWallet("hrw_1/../health");

    expect(result.sync).toMatchObject({ degraded: false });
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      "/api/dashboard/helius-rings/wallets/hrw_1%2F..%2Fhealth/sync"
    );

    respondWith(503, { error: { message: "the indexer is unavailable" } });
    await expect(syncRingsWallet("hrw_1")).resolves.toEqual({
      error: "the indexer is unavailable",
    });
  });
});
