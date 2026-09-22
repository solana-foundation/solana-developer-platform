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
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  assertRpcCluster,
  assertSimulatedOwnerTokenDelta,
  signTransaction,
} from "./solana";

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
        await signTransaction(unsigned, [customer, northstar], {
          feePayerAddress: northstar.address,
        }),
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

describe("Northstar pre-submit simulation", () => {
  afterEach(() => vi.unstubAllGlobals());

  let customer: Address;
  let northstar: Address;
  let usdc: Address;
  // The check decodes the signed bytes to find the signer slots, so the
  // fixtures are real transactions: one signer (owner pays) and two (sponsor
  // at slot zero, owner at slot one).
  let singleSignerTx: string;
  let cosignedTx: string;

  beforeAll(async () => {
    customer = (await generateKeyPairSigner()).address;
    northstar = (await generateKeyPairSigner()).address;
    usdc = (await generateKeyPairSigner()).address;
    singleSignerTx = unsignedTransaction(customer, customer);
    cosignedTx = unsignedTransaction(customer, northstar);
  });

  function simulateWith(value: Record<string, unknown>) {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(Response.json({ jsonrpc: "2.0", result: { value } }))
    );
  }

  function balances(params: {
    preTokenAtoms?: string;
    postTokenAtoms?: string;
    preSol?: (number | string)[];
    postSol?: (number | string)[];
    err?: unknown;
  }) {
    const tokenRow = (atoms: string | undefined) =>
      atoms === undefined
        ? []
        : [{ owner: customer, mint: usdc, uiTokenAmount: { amount: atoms } }];
    return {
      err: params.err ?? null,
      preBalances: params.preSol ?? [10_000_000_000],
      postBalances: params.postSol ?? [10_000_000_000],
      preTokenBalances: tokenRow(params.preTokenAtoms),
      postTokenBalances: tokenRow(params.postTokenAtoms),
    };
  }

  it("accepts a deposit whose simulated delta is exactly the request", async () => {
    simulateWith(
      balances({ preTokenAtoms: "500000000", postTokenAtoms: "450000000" })
    );

    await expect(
      assertSimulatedOwnerTokenDelta(
        "https://rpc.example.test",
        singleSignerTx,
        {
          ownerAddress: customer,
          mint: usdc,
          atoms: -50_000_000n,
          tolerance: "exact",
        }
      )
    ).resolves.toBeUndefined();
  });

  it("refuses a deposit that moves more of the savings token than requested", async () => {
    simulateWith(balances({ preTokenAtoms: "500000000", postTokenAtoms: "0" }));

    await expect(
      assertSimulatedOwnerTokenDelta(
        "https://rpc.example.test",
        singleSignerTx,
        {
          ownerAddress: customer,
          mint: usdc,
          atoms: -50_000_000n,
          tolerance: "exact",
        }
      )
    ).rejects.toThrow("instead of exactly -50000000");
  });

  it("refuses a withdrawal whose payout lands below the floor", async () => {
    simulateWith(balances({ preTokenAtoms: "0", postTokenAtoms: "1000000" }));

    await expect(
      assertSimulatedOwnerTokenDelta(
        "https://rpc.example.test",
        singleSignerTx,
        {
          ownerAddress: customer,
          mint: usdc,
          atoms: 9_950_000n,
          tolerance: "atLeast",
        }
      )
    ).rejects.toThrow("instead of at least 9950000");
  });

  it("refuses a build that drains a signer's SOL past fees and rent", async () => {
    // The customer signs (slot one of a cosigned build) and the token deltas
    // match the request; only their SOL balance gives the drain away.
    simulateWith(
      balances({
        preTokenAtoms: "500000000",
        postTokenAtoms: "450000000",
        preSol: [10_000_000_000, 500_000_000],
        postSol: [10_000_000_000, 1],
      })
    );

    await expect(
      assertSimulatedOwnerTokenDelta("https://rpc.example.test", cosignedTx, {
        ownerAddress: customer,
        mint: usdc,
        atoms: -50_000_000n,
        tolerance: "exact",
        feePayerAddress: northstar,
      })
    ).rejects.toThrow("past the fee-and-rent ceiling");
  });

  it("refuses a build whose sponsor is drained through its fee slot", async () => {
    simulateWith(
      balances({
        preTokenAtoms: "500000000",
        postTokenAtoms: "450000000",
        preSol: [10_000_000_000, 500_000_000],
        postSol: [0, 500_000_000],
      })
    );

    await expect(
      assertSimulatedOwnerTokenDelta("https://rpc.example.test", cosignedTx, {
        ownerAddress: customer,
        mint: usdc,
        atoms: -50_000_000n,
        tolerance: "exact",
        feePayerAddress: northstar,
      })
    ).rejects.toThrow("past the fee-and-rent ceiling");
  });

  it("refuses the submit when the simulation itself fails on chain", async () => {
    simulateWith(balances({ err: { InstructionError: [0, "Custom"] } }));

    await expect(
      assertSimulatedOwnerTokenDelta(
        "https://rpc.example.test",
        singleSignerTx,
        {
          ownerAddress: customer,
          mint: usdc,
          atoms: -50_000_000n,
          tolerance: "exact",
        }
      )
    ).rejects.toThrow("Simulated SDP transaction failed on chain");
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
