import * as solanaRpc from "@sdp/rpc/solana";
import {
  type Address,
  addSignersToTransactionMessage,
  appendTransactionMessageInstructions,
  type Blockhash,
  createKeyPairSignerFromPrivateKeyBytes,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase58Codec,
  getSignatureFromTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransactionMessageWithSigners,
  pipe,
  type Signature,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "@/types/env";
import { NativeAdapter } from "./native.adapter";

const base58 = getBase58Codec();
const decoder = getTransactionDecoder();
const encoder = getTransactionEncoder();

/**
 * Build a funded-fee-payer-style keypair: returns the base58 64-byte secret
 * (what FEE_PAYER_PRIVATE_KEY holds) plus its address for assertions.
 */
async function makeFeePayerSecret(seedByte: number): Promise<{ secret: string; address: Address }> {
  const seed = new Uint8Array(32).fill(seedByte);
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed, true);
  const publicKey = new Uint8Array(
    (await crypto.subtle.exportKey("raw", signer.keyPair.publicKey)) as ArrayBuffer
  );
  const secretBytes = new Uint8Array(64);
  secretBytes.set(seed, 0);
  secretBytes.set(publicKey, 32);
  return { secret: base58.decode(secretBytes), address: signer.address };
}

/**
 * Build a SOL transfer transaction that the source wallet has already signed but
 * whose fee payer slot is still empty — exactly what the transfer handlers hand to
 * the fee payment adapter via `signAndSend`.
 */
async function buildSourceSignedTransfer(feePayer: Address): Promise<{
  txBytes: Uint8Array;
  source: Address;
}> {
  const sourceSigner = await generateKeyPairSigner();
  const destination = (await generateKeyPairSigner()).address;
  const blockhash = base58.decode(new Uint8Array(32).fill(1)) as Blockhash;

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight: 100n }, m),
    (m) =>
      appendTransactionMessageInstructions(
        [getTransferSolInstruction({ source: sourceSigner, destination, amount: 1000n })],
        m
      ),
    (m) => addSignersToTransactionMessage([sourceSigner], m)
  );

  const partiallySigned = await partiallySignTransactionMessageWithSigners(message);
  return {
    txBytes: new Uint8Array(encoder.encode(partiallySigned)),
    source: sourceSigner.address,
  };
}

describe("NativeAdapter", () => {
  // The Workers test pool shares one module registry across files (isolate: false),
  // so a top-level `vi.mock("@/services/solana/rpc")` doesn't reliably intercept once
  // another test file has already imported the real module.
  beforeEach(() => {
    vi.spyOn(solanaRpc, "createRpc").mockReturnValue({} as ReturnType<typeof solanaRpc.createRpc>);
    vi.spyOn(solanaRpc, "sendTransaction").mockResolvedValue("1".repeat(64) as Signature);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("getFeePayer returns the address of the configured keypair", async () => {
    const feePayer = await makeFeePayerSecret(7);
    const adapter = new NativeAdapter({ FEE_PAYER_PRIVATE_KEY: feePayer.secret } as unknown as Env);

    await expect(adapter.getFeePayer()).resolves.toBe(feePayer.address);
  });

  it("falls back to CUSTODY_PRIVATE_KEY when FEE_PAYER_PRIVATE_KEY is unset", async () => {
    const feePayer = await makeFeePayerSecret(9);
    const adapter = new NativeAdapter({ CUSTODY_PRIVATE_KEY: feePayer.secret } as unknown as Env);

    await expect(adapter.getFeePayer()).resolves.toBe(feePayer.address);
  });

  it("signAsFeePayer adds the fee payer signature while preserving the source signature", async () => {
    const feePayer = await makeFeePayerSecret(7);
    const adapter = new NativeAdapter({ FEE_PAYER_PRIVATE_KEY: feePayer.secret } as unknown as Env);
    const { txBytes, source } = await buildSourceSignedTransfer(feePayer.address);

    const before = decoder.decode(txBytes);
    expect(before.signatures[feePayer.address]).toBeNull();

    const signedBytes = await adapter.signAsFeePayer(txBytes);
    const after = decoder.decode(signedBytes);

    expect(after.signatures[feePayer.address]).not.toBeNull();
    expect(() => getSignatureFromTransaction(after)).not.toThrow();
    expect(after.signatures[source]).toEqual(before.signatures[source]);
  });

  it("signAndSend signs as fee payer and submits the fully-signed tx over RPC", async () => {
    const feePayer = await makeFeePayerSecret(7);
    const adapter = new NativeAdapter({ FEE_PAYER_PRIVATE_KEY: feePayer.secret } as unknown as Env);
    const { txBytes } = await buildSourceSignedTransfer(feePayer.address);

    const expectedSignature = "5".repeat(64) as Signature;
    vi.mocked(solanaRpc.sendTransaction).mockResolvedValue(expectedSignature);

    const signature = await adapter.signAndSend(txBytes);

    expect(signature).toBe(expectedSignature);
    expect(solanaRpc.sendTransaction).toHaveBeenCalledTimes(1);

    const submitted = vi.mocked(solanaRpc.sendTransaction).mock.calls[0]?.[1] as Uint8Array;
    expect(decoder.decode(submitted).signatures[feePayer.address]).not.toBeNull();
  });

  it("throws PROVIDER_NOT_AVAILABLE when no keypair is configured", async () => {
    const adapter = new NativeAdapter({} as Env);
    const { txBytes } = await buildSourceSignedTransfer((await makeFeePayerSecret(7)).address);

    await expect(adapter.signAndSend(txBytes)).rejects.toMatchObject({
      name: "FeePaymentError",
      code: "PROVIDER_NOT_AVAILABLE",
    });
    expect(solanaRpc.sendTransaction).not.toHaveBeenCalled();
  });

  it("wraps RPC submission failures as a SUBMISSION_FAILED FeePaymentError", async () => {
    const feePayer = await makeFeePayerSecret(7);
    const adapter = new NativeAdapter({ FEE_PAYER_PRIVATE_KEY: feePayer.secret } as unknown as Env);
    const { txBytes } = await buildSourceSignedTransfer(feePayer.address);

    vi.mocked(solanaRpc.sendTransaction).mockRejectedValue(new Error("blockhash not found"));

    await expect(adapter.signAndSend(txBytes)).rejects.toMatchObject({
      name: "FeePaymentError",
      code: "SUBMISSION_FAILED",
    });
  });
});
