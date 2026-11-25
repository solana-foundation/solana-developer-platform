import { generateKeyPairSync } from "node:crypto";
import { generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { testRuntime } from "#/test/runtime";
import { readFireblocksAddressBook } from "./address-book";
import { provisionFireblocksVaultAccount } from "./provisioning";
import { readFireblocksTransfer, resolveFireblocksTransferAsset } from "./transfers";
import { listFireblocksVaults } from "./vaults";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const { address: VAULT_ADDRESS } = await generateKeyPairSigner();
function access() {
  return {
    apiKey: crypto.randomUUID(),
    apiSecretPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    apiBaseUrl: "https://fireblocks.example.test",
  };
}
describe("Fireblocks provider boundaries", () => {
  it("allows unrelated catalogue assets without optional metadata, requiring the selected token's decimals", async () => {
    const token = { id: "USDC_SOL", type: "SOL_ASSET", nativeAsset: "SOL", issuerAddress: "mint" };
    const catalogue = (decimals: number | undefined) =>
      testRuntime(async () =>
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
    const rt = testRuntime(async () => Response.json({ id: "tx", status: "COMPLETED", ...patch }));
    await expect(readFireblocksTransfer(rt, access(), "external-id")).rejects.toThrow(
      "Invalid Fireblocks transfer response"
    );
  });
  it("does not cache malformed address-book replies", async () => {
    let malformed = true;
    let reads = 0;
    const rt = testRuntime(async () => {
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
          testRuntime(async () => Response.json(page)),
          { ...access(), assetId: "SOL" }
        )
      ).rejects.toThrow("Invalid Fireblocks vault page");
    }
  });
  it("uses distinct stable idempotency keys for vault and asset creation", async () => {
    const writes: Array<{ uri: string; key: string | null }> = [];
    const rt = testRuntime(async (url, init) => {
      const uri = new URL(String(url)).pathname;
      if (init?.method === "POST") {
        writes.push({ uri, key: new Headers(init.headers).get("Idempotency-Key") });
        return Response.json({ id: "0" });
      }
      return Response.json({ addresses: [{ address: VAULT_ADDRESS }] });
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
