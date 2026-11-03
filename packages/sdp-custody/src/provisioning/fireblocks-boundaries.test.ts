import { generateKeyPairSync, webcrypto } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readFireblocksAddressBook } from "./fireblocks-address-book";
import { readFireblocksTransfer, resolveFireblocksTransferAsset } from "./fireblocks-transfers";
import { listFireblocksVaults } from "./fireblocks-vaults";
import { provisionFireblocksVaultAccount } from "./index";
import type { CustodyProvisioningRuntime } from "./runtime";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
function access() {
  return {
    apiKey: crypto.randomUUID(),
    apiSecretPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    apiBaseUrl: "https://fireblocks.example.test",
  };
}
function runtime(fetch: CustodyProvisioningRuntime["fetch"]): CustodyProvisioningRuntime {
  return {
    fetch,
    sleep: async () => {},
    now: Date.now,
    randomUUID: () => crypto.randomUUID(),
    getRandomValues: (data) => webcrypto.getRandomValues(new Uint8Array(data)),
    sha256: async (data) => webcrypto.subtle.digest("SHA-256", new Uint8Array(data)),
  };
}
describe("Fireblocks provider boundaries", () => {
  it("allows unrelated catalogue assets without optional metadata, requiring the selected token's decimals", async () => {
    const token = { id: "USDC_SOL", type: "SOL_ASSET", nativeAsset: "SOL", issuerAddress: "mint" };
    const catalogue = (decimals: number | undefined) =>
      runtime(async () =>
        Response.json([
          { id: "BTC", type: "BASE_ASSET" },
          { ...token, decimals },
        ])
      );
    await expect(
      resolveFireblocksTransferAsset(catalogue(6), access(), "SOL", "mint")
    ).resolves.toEqual({ id: "USDC_SOL", decimals: 6 });
    await expect(
      resolveFireblocksTransferAsset(catalogue(undefined), access(), "SOL", "mint")
    ).rejects.toThrow("not uniquely supported");
  });
  it.each([
    { source: [] },
    { amountInfo: { netAmount: "-1" } },
    { feeInfo: { networkFee: 1 } },
    { status: "untrusted status" },
  ])("rejects malformed transfer detail %j", async (patch) => {
    const rt = runtime(async () => Response.json({ id: "tx", status: "COMPLETED", ...patch }));
    await expect(readFireblocksTransfer(rt, access(), "external-id")).rejects.toThrow(
      "Invalid Fireblocks transfer response"
    );
  });
  it("does not cache malformed address-book replies", async () => {
    let malformed = true;
    let reads = 0;
    const rt = runtime(async () => {
      reads++;
      return Response.json([
        {
          id: "wallet",
          name: "Recipient",
          assets: [
            { id: "SOL", address: "address", status: malformed ? "UNRECOGNIZED" : "APPROVED" },
          ],
        },
      ]);
    });
    const credential = access();
    await expect(readFireblocksAddressBook(rt, credential)).rejects.toThrow(
      "Invalid Fireblocks address book response"
    );
    malformed = false;
    expect(await readFireblocksAddressBook(rt, credential)).toHaveLength(2);
    expect(reads).toBe(4);
  });
  it("rejects malformed vault IDs and pagination without following provider URLs", async () => {
    for (const page of [
      { accounts: [{ id: "../other", name: "Vault", assets: [] }] },
      { accounts: [], paging: { after: 7 } },
    ]) {
      await expect(
        listFireblocksVaults(
          runtime(async () => Response.json(page)),
          { ...access(), assetId: "SOL" }
        )
      ).rejects.toThrow("Invalid Fireblocks vault page");
    }
  });
  it("uses distinct stable idempotency keys for vault and asset creation", async () => {
    const writes: Array<{ uri: string; key: string | null }> = [];
    const rt = runtime(async (url, init) => {
      const uri = new URL(String(url)).pathname;
      if (init?.method === "POST") {
        writes.push({ uri, key: new Headers(init.headers).get("Idempotency-Key") });
        return Response.json({ id: "0" });
      }
      return Response.json({ addresses: [{ address: "11111111111111111111111111111111" }] });
    });
    for (let attempt = 0; attempt < 2; attempt++)
      await provisionFireblocksVaultAccount(
        rt,
        { ...access(), assetId: "SOL" },
        { orgId: "org", orgSlug: "project", idempotencyKey: "create-wallet" }
      );
    expect(writes).toEqual([
      { uri: "/v1/vault/accounts", key: "create-wallet:vault" },
      { uri: "/v1/vault/accounts/0/SOL", key: "create-wallet:asset" },
      { uri: "/v1/vault/accounts", key: "create-wallet:vault" },
      { uri: "/v1/vault/accounts/0/SOL", key: "create-wallet:asset" },
    ]);
  });
});
