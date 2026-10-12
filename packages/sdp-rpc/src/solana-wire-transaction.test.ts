import assert from "node:assert/strict";
import test from "node:test";
import {
  type Address,
  type Blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase58Codec,
  getTransactionEncoder,
  pipe,
  type Signature,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { type SolanaRpc, sendTransaction, simulateTransaction } from "./solana";

const FEE_PAYER = "11111111111111111111111111111111" as Address;
const BLOCKHASH = getBase58Codec().decode(new Uint8Array(32).fill(7)) as Blockhash;
const SIGNATURE = "sig111" as Signature;

const wire = new Uint8Array(
  getTransactionEncoder().encode(
    compileTransaction(
      pipe(
        createTransactionMessage({ version: 0 }),
        (message) => setTransactionMessageFeePayer(FEE_PAYER, message),
        (message) =>
          setTransactionMessageLifetimeUsingBlockhash(
            { blockhash: BLOCKHASH, lastValidBlockHeight: 100n },
            message
          )
      )
    )
  )
);
const wireBase64 = Buffer.from(wire).toString("base64");

function bufferViewIntoLargerBuffer(): Buffer {
  const backing = Buffer.alloc(65536);
  backing.set(wire);
  return backing.subarray(0, wire.length);
}

function recordingRpc(): { rpc: SolanaRpc; encoded: () => string[] } {
  const encoded: string[] = [];
  const rpc = {
    sendTransaction: (encodedTransaction: string) => {
      encoded.push(encodedTransaction);
      return { send: async () => SIGNATURE };
    },
    simulateTransaction: (encodedTransaction: string) => {
      encoded.push(encodedTransaction);
      return { send: async () => ({ value: { err: null, logs: [], unitsConsumed: 0n } }) };
    },
  } as unknown as SolanaRpc;
  return { rpc, encoded: () => encoded };
}

test("sends only the transaction's own bytes when it is a Buffer view at the start of a larger buffer", async () => {
  const { rpc, encoded } = recordingRpc();

  assert.equal(await sendTransaction(rpc, bufferViewIntoLargerBuffer()), SIGNATURE);
  assert.deepEqual(encoded(), [wireBase64]);
});

test("simulates only the transaction's own bytes when it is a Buffer view at the start of a larger buffer", async () => {
  const { rpc, encoded } = recordingRpc();

  await simulateTransaction(rpc, bufferViewIntoLargerBuffer());
  assert.deepEqual(encoded(), [wireBase64]);
});
