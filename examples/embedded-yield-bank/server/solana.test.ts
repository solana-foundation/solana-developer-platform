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
      Buffer.from(
        await signTransaction(unsigned, [customer], customer.address),
        "base64"
      )
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
        await signTransaction(
          unsigned,
          [customer, northstar],
          northstar.address
        ),
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

  it("refuses to sign when the compiled fee payer differs from configuration", async () => {
    const customer = await generateKeyPairSigner();
    const unexpected = await generateKeyPairSigner();
    const unsigned = unsignedTransaction(customer.address, unexpected.address);

    await expect(
      signTransaction(unsigned, [customer], customer.address)
    ).rejects.toThrow("fee payer does not match");
  });
});

describe("Northstar RPC cluster guard", () => {
  // The chain's own genesis hashes, independent of the implementation's table.
  const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
  const MAINNET_BETA_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

  it("accepts the configured cluster and rejects a mismatch", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      Response.json({
        jsonrpc: "2.0",
        id: "test",
        result: DEVNET_GENESIS,
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

  it("accepts an endpoint that really serves mainnet-beta, proving each URL once", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return Response.json({
        jsonrpc: "2.0",
        id: "test",
        result: MAINNET_BETA_GENESIS,
      });
    };

    try {
      const rpcUrl = "https://mainnet.example.test";
      await expect(
        assertRpcCluster(rpcUrl, "mainnet-beta")
      ).resolves.toBeUndefined();
      await expect(
        assertRpcCluster(rpcUrl, "mainnet-beta")
      ).resolves.toBeUndefined();
      // The verified answer is remembered per URL: the second call probes nothing.
      expect(calls).toBe(1);
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
