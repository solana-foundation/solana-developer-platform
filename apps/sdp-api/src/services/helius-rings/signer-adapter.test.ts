import { SigningError } from "@sdp/custody/signing";
import type { SolanaRpc } from "@sdp/rpc/solana";
import {
  type Address,
  type Blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase58Codec,
  getBase64Codec,
  getTransactionDecoder,
  getTransactionEncoder,
  pipe,
  type SignatureBytes,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import type { TransactionPartialSigner } from "@solana/signers";
import { describe, expect, it } from "vitest";
import type { Env } from "@/types/env";
import { RingsAdapterError } from "./adapter-error";
import { submitRingsOuterTransaction } from "./rpc-adapter";
import { signRingsOuterTransaction } from "./signer-adapter";

const FEE_PAYER = "11111111111111111111111111111111" as Address;
const BLOCKHASH = getBase58Codec().decode(new Uint8Array(32).fill(7)) as Blockhash;

const base64 = getBase64Codec();
const env = {} as Env;

function unsignedTxBase64(): string {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (current) => setTransactionMessageFeePayer(FEE_PAYER, current),
    (current) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: BLOCKHASH, lastValidBlockHeight: 100n },
        current
      )
  );
  return base64.decode(getTransactionEncoder().encode(compileTransaction(message)));
}

function partialSigner(
  sign: () => Promise<Array<Record<Address, SignatureBytes>>>
): TransactionPartialSigner {
  return { address: FEE_PAYER, signTransactions: sign };
}

describe("signRingsOuterTransaction", () => {
  it("attaches the custody signature and returns base64 wire bytes", async () => {
    const signature = new Uint8Array(64).fill(7) as SignatureBytes;
    const signer = partialSigner(async () => [{ [FEE_PAYER]: signature }]);

    const signed = await signRingsOuterTransaction({
      env,
      organizationId: "org_1",
      projectId: "prj_1",
      unsignedTxBase64: unsignedTxBase64(),
      signer,
    });

    const decoded = getTransactionDecoder().decode(base64.encode(signed));
    expect(decoded.signatures[FEE_PAYER]).toEqual(signature);
  });

  it("maps a transient signer error to a retryable signer_failed", async () => {
    const signer = partialSigner(async () => {
      throw new SigningError("provider timeout", "NETWORK_ERROR");
    });

    const error = await signRingsOuterTransaction({
      env,
      organizationId: "org_1",
      projectId: "prj_1",
      unsignedTxBase64: unsignedTxBase64(),
      signer,
    }).then(
      () => null,
      (thrown: unknown) => thrown
    );

    expect(error).toBeInstanceOf(RingsAdapterError);
    expect(error).toMatchObject({ failureCode: "signer_failed", retryable: true });
  });

  it("marks a missing wallet as non-retryable", async () => {
    const signer = partialSigner(async () => {
      throw new SigningError("no such wallet", "WALLET_NOT_FOUND");
    });

    const error = await signRingsOuterTransaction({
      env,
      organizationId: "org_1",
      projectId: "prj_1",
      unsignedTxBase64: unsignedTxBase64(),
      signer,
    }).then(
      () => null,
      (thrown: unknown) => thrown
    );

    expect(error).toMatchObject({ failureCode: "signer_failed", retryable: false });
  });
});

describe("submitRingsOuterTransaction", () => {
  it("broadcasts and returns the signature", async () => {
    const rpc = {
      sendTransaction: () => ({ send: async () => "sig_abc" }),
    } as unknown as SolanaRpc;

    await expect(
      submitRingsOuterTransaction({ env, signedTxBase64: unsignedTxBase64(), rpc })
    ).resolves.toBe("sig_abc");
  });

  it("maps a broadcast failure to a retryable submit_failed", async () => {
    const rpc = {
      sendTransaction: () => ({
        send: async () => {
          throw new Error("blockhash not found");
        },
      }),
    } as unknown as SolanaRpc;

    const error = await submitRingsOuterTransaction({
      env,
      signedTxBase64: unsignedTxBase64(),
      rpc,
    }).then(
      () => null,
      (thrown: unknown) => thrown
    );

    expect(error).toBeInstanceOf(RingsAdapterError);
    expect(error).toMatchObject({
      failureCode: "submit_failed",
      retryable: true,
      message: "blockhash not found",
    });
  });
});
