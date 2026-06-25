import { KoraAdapter } from "@sdp/api/services/adapters";
import { confirmTransaction, createRpc, getRecentBlockhash } from "@sdp/api/services/solana/rpc";
import {
  type Address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { describe, expect, it } from "vitest";
import { env, RUN_INTEGRATION_TESTS } from "../helpers/integration";

const koraSurfpoolShim = (env as { KORA_SURFPOOL_SHIM?: string }).KORA_SURFPOOL_SHIM;
const MEMO_PROGRAM_ADDRESS = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" as Address;

describe.skipIf(koraSurfpoolShim !== "true" || !RUN_INTEGRATION_TESTS)("Kora Surfpool shim", () => {
  it("signs and sends a fee-payer transaction through the regular Kora adapter", async () => {
    if (!env.KORA_RPC_URL) {
      throw new Error("KORA_RPC_URL is required for the Kora Surfpool shim test.");
    }

    const adapter = new KoraAdapter({ rpcUrl: env.KORA_RPC_URL });
    const rpc = createRpc(env);
    const feePayer = await adapter.getFeePayer();
    const { blockhash, lastValidBlockHeight } = await getRecentBlockhash(rpc, "confirmed");
    const instruction = {
      programAddress: MEMO_PROGRAM_ADDRESS,
      accounts: [],
      data: new TextEncoder().encode(`kora surfpool shim ${Date.now()}`),
    };
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(feePayer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash, lastValidBlockHeight }, m),
      (m) => appendTransactionMessageInstructions([instruction], m)
    );
    const transactionBytes = new Uint8Array(
      getTransactionEncoder().encode(compileTransaction(message))
    );

    const signature = await adapter.signAndSend(transactionBytes);
    const confirmation = await confirmTransaction(rpc, signature, { commitment: "confirmed" });

    expect(confirmation.err).toBeNull();
  });
});
