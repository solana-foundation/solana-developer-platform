import {
  AccountRole,
  type Address,
  address,
  appendTransactionMessageInstruction,
  type Blockhash,
  compileTransaction,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase58Codec,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { describe, expect, it } from "vitest";
import { assertRpcCluster, signTransaction } from "./solana";

const blockhash = getBase58Codec().decode(
  new Uint8Array(32).fill(1)
) as Blockhash;

describe("Northstar transaction signing", () => {
  it("uses the customer as fee payer when no sponsor is configured", async () => {
    const customer = await generateKeyPairSigner();
    const unsigned = unsignedTransaction(customer.address, customer.address);

    const signed = getTransactionDecoder().decode(
      Buffer.from(await signTransaction(unsigned, [customer]), "base64")
    );

    expect(Object.keys(signed.signatures)).toEqual([customer.address]);
    expect(signed.signatures[customer.address]).not.toBeNull();
  });

  it("co-signs when Northstar is the configured fee payer", async () => {
    const customer = await generateKeyPairSigner();
    const northstar = await generateKeyPairSigner();
    const unsigned = unsignedTransaction(customer.address, northstar.address);

    const signed = getTransactionDecoder().decode(
      Buffer.from(
        await signTransaction(unsigned, [customer, northstar]),
        "base64"
      )
    );

    expect(Object.keys(signed.signatures)).toEqual([
      northstar.address,
      customer.address,
    ]);
    expect(signed.signatures[northstar.address]).not.toBeNull();
    expect(signed.signatures[customer.address]).not.toBeNull();
  });

  it("refuses a transaction that does not require every configured signer", async () => {
    const customer = await generateKeyPairSigner();
    const northstar = await generateKeyPairSigner();
    // Fee payer echo only checks the build JSON; the bytes are what gets
    // signed. A build whose instructions require the sponsor's signature
    // alone (a plain SOL drain, here) would otherwise take the sponsor's
    // signature while the customer's key signed along unrequired.
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (current) => setTransactionMessageFeePayer(northstar.address, current),
      (current) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash, lastValidBlockHeight: 100n },
          current
        ),
      (current) =>
        appendTransactionMessageInstruction(
          {
            programAddress: address("11111111111111111111111111111111"),
            accounts: [
              { address: northstar.address, role: AccountRole.WRITABLE },
              { address: customer.address, role: AccountRole.WRITABLE },
            ],
          },
          current
        ),
      compileTransaction
    );

    await expect(
      signTransaction(getBase64EncodedWireTransaction(message), [
        customer,
        northstar,
      ])
    ).rejects.toThrow("does not require exactly the configured signer set");
  });

  it("refuses a transaction that requires an unconfigured signer", async () => {
    const customer = await generateKeyPairSigner();
    const northstar = await generateKeyPairSigner();
    const stranger = await generateKeyPairSigner();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (current) => setTransactionMessageFeePayer(northstar.address, current),
      (current) =>
        setTransactionMessageLifetimeUsingBlockhash(
          { blockhash, lastValidBlockHeight: 100n },
          current
        ),
      (current) =>
        appendTransactionMessageInstruction(
          {
            programAddress: address("11111111111111111111111111111111"),
            accounts: [
              { address: customer.address, role: AccountRole.READONLY_SIGNER },
              { address: stranger.address, role: AccountRole.READONLY_SIGNER },
            ],
          },
          current
        ),
      compileTransaction
    );

    await expect(
      signTransaction(getBase64EncodedWireTransaction(message), [
        customer,
        northstar,
      ])
    ).rejects.toThrow("does not require exactly the configured signer set");
  });
});

describe("Northstar RPC cluster guard", () => {
  it("accepts the configured cluster and rejects a mismatch", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      Response.json({
        jsonrpc: "2.0",
        id: "test",
        result: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
      });

    try {
      await expect(
        assertRpcCluster("https://devnet.example.test", "devnet")
      ).resolves.toBeUndefined();
      await expect(
        assertRpcCluster("https://wrong.example.test", "mainnet-beta")
      ).rejects.toThrow("does not serve mainnet-beta");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function unsignedTransaction(customer: Address, feePayer: Address): string {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (current) => setTransactionMessageFeePayer(feePayer, current),
    (current) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash, lastValidBlockHeight: 100n },
        current
      ),
    (current) =>
      appendTransactionMessageInstruction(
        {
          programAddress: address("11111111111111111111111111111111"),
          accounts: [{ address: customer, role: AccountRole.READONLY_SIGNER }],
        },
        current
      ),
    compileTransaction
  );
  return getBase64EncodedWireTransaction(message);
}
