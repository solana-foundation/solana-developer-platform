import { apiTestSupport } from "@sdp/api/test-support";
import { confirmTransaction, createRpc, getRecentBlockhash } from "@sdp/rpc/solana";
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
import { RUN_INTEGRATION_TESTS } from "#/helpers/integration";
import { requireKoraEndpoint } from "#/helpers/kora";
import { env } from "#env-impl";

const { DVP_SWAP_PROGRAM_PROGRAM_ADDRESS, KoraAdapter, KoraClient } = apiTestSupport;

const koraSurfpoolShim = (env as { KORA_SURFPOOL_SHIM?: string }).KORA_SURFPOOL_SHIM;
const MEMO_PROGRAM_ADDRESS = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" as Address;

describe.skipIf(koraSurfpoolShim !== "true" || !RUN_INTEGRATION_TESTS)("Kora Surfpool shim", () => {
  it("signs and sends a fee-payer transaction through the regular Kora adapter", async () => {
    const { rpcUrl } = requireKoraEndpoint();
    const adapter = new KoraAdapter({
      rpcUrl,
      userId: "sdp:v1:system:integration-kora-surfpool-shim",
    });
    const config = await new KoraClient({ rpcUrl }).getConfig();
    expect(config.validation_config.allowed_programs).toContain(DVP_SWAP_PROGRAM_PROGRAM_ADDRESS);
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

  it("answers a duplicate submit with the original signature, as the cluster does", async () => {
    const { rpcUrl } = requireKoraEndpoint();
    const adapter = new KoraAdapter({
      rpcUrl,
      userId: "sdp:v1:system:integration-kora-surfpool-shim",
    });
    const rpc = createRpc(env);
    const feePayer = await adapter.getFeePayer();
    const { blockhash, lastValidBlockHeight } = await getRecentBlockhash(rpc, "confirmed");
    const instruction = {
      programAddress: MEMO_PROGRAM_ADDRESS,
      accounts: [],
      data: new TextEncoder().encode(`kora surfpool shim duplicate ${Date.now()}`),
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
    await confirmTransaction(rpc, signature, { commitment: "confirmed" });

    const replayed = await adapter.signAndSend(transactionBytes);

    expect(replayed).toBe(signature);
  });
});
