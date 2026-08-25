import type { SolanaRpc } from "@sdp/rpc/solana";
import {
  type Address,
  type Blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase58Codec,
  getBase64Codec,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "@/types/env";
import { inspectRingsSignature } from "./rpc-adapter";

/**
 * The oracle behind the only write that releases a money-safety hold, so what
 * matters here is what it does with a *miss*. A transaction's presence needs
 * one positive answer; its absence is not established by any single response,
 * because `getTransaction` returning null means "not in this node's store".
 */

const FEE_PAYER = "11111111111111111111111111111111" as Address;
const BLOCKHASH = getBase58Codec().decode(new Uint8Array(32).fill(7)) as Blockhash;
const env = {} as Env;

function signedTxBase64(): string {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (current) => setTransactionMessageFeePayer(FEE_PAYER, current),
    (current) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: BLOCKHASH, lastValidBlockHeight: 100n },
        current
      )
  );
  return getBase64Codec().decode(getTransactionEncoder().encode(compileTransaction(message)));
}

function rpcWith(options: {
  blockhashValid: boolean;
  statusSlot?: bigint | null;
  statusErr?: string;
  transactionSlot?: bigint | null;
}): { rpc: SolanaRpc; calls: string[] } {
  const calls: string[] = [];
  const send = (name: string, value: unknown) => () => {
    calls.push(name);
    return Promise.resolve(value);
  };

  return {
    calls,
    rpc: {
      isBlockhashValid: () => ({
        send: send("isBlockhashValid", { value: options.blockhashValid }),
      }),
      getSignatureStatuses: (
        _signatures: unknown,
        config?: { searchTransactionHistory?: boolean }
      ) => ({
        send: send(`getSignatureStatuses:history=${config?.searchTransactionHistory}`, {
          value: [
            options.statusSlot == null
              ? null
              : {
                  slot: options.statusSlot,
                  err: options.statusErr ?? null,
                  confirmationStatus: "finalized",
                },
          ],
        }),
      }),
      getTransaction: () => ({
        send: send(
          "getTransaction",
          options.transactionSlot == null ? null : { slot: options.transactionSlot }
        ),
      }),
    } as unknown as SolanaRpc,
  };
}

describe("inspectRingsSignature", () => {
  it("reports landed when the status search finds it", async () => {
    const { rpc } = rpcWith({ blockhashValid: false, statusSlot: 4242n });

    const result = await inspectRingsSignature({
      env,
      signature: "sig",
      signedTxBase64: signedTxBase64(),
      rpc,
    });

    expect(result.landedSlot).toBe("4242");
  });

  it("reports landed when only the second history source finds it", async () => {
    const { rpc } = rpcWith({ blockhashValid: false, statusSlot: null, transactionSlot: 99n });

    const result = await inspectRingsSignature({
      env,
      signature: "sig",
      signedTxBase64: signedTxBase64(),
      rpc,
    });

    // Either source is enough to say it landed. Only both missing can support
    // the opposite conclusion, which is the asymmetry the whole design rests on.
    expect(result.landedSlot).toBe("99");
  });

  it("reports absent only when both history sources miss", async () => {
    const { rpc } = rpcWith({ blockhashValid: false, statusSlot: null, transactionSlot: null });

    const result = await inspectRingsSignature({
      env,
      signature: "sig",
      signedTxBase64: signedTxBase64(),
      rpc,
    });

    expect(result.landedSlot).toBeNull();
    expect(result.evidence).toEqual({
      statusSlot: null,
      statusConfirmation: null,
      transactionSlot: null,
      executionFailed: false,
      blockhashValid: false,
    });
  });

  it("reports a landed transaction that reverted", async () => {
    const { rpc } = rpcWith({
      blockhashValid: false,
      statusSlot: 4242n,
      statusErr: "InstructionError",
    });

    const result = await inspectRingsSignature({
      env,
      signature: "sig",
      signedTxBase64: signedTxBase64(),
      rpc,
    });

    // The distinction Photon cannot make: it landed, so it is not absent, but
    // it changed no shielded state, so the indexer will never report it.
    expect(result.landedSlot).toBe("4242");
    expect(result.executionFailed).toBe(true);
  });

  it("searches transaction history rather than the recent status cache", async () => {
    const { rpc, calls } = rpcWith({ blockhashValid: false, statusSlot: null });

    await inspectRingsSignature({
      env,
      signature: "sig",
      signedTxBase64: signedTxBase64(),
      rpc,
    });

    // Without history search the call only consults a cache of recent slots,
    // which misses anything older than a minute or so and would read as absent.
    expect(calls).toContain("getSignatureStatuses:history=true");
  });

  it("asks each question in turn rather than concurrently", async () => {
    const { rpc, calls } = rpcWith({ blockhashValid: true, statusSlot: null });

    await inspectRingsSignature({
      env,
      signature: "sig",
      signedTxBase64: signedTxBase64(),
      rpc,
    });

    // Concurrent calls to one URL can be answered by different backends, and
    // these read different state: the blockhash comes from the bank, which
    // every node has, while history may not be there at all.
    expect(calls).toEqual([
      "isBlockhashValid",
      "getSignatureStatuses:history=true",
      "getTransaction",
    ]);
  });

  it("reads the blockhash from the signed bytes", async () => {
    const isBlockhashValid = vi.fn(() => ({ send: async () => ({ value: false }) }));
    const { rpc } = rpcWith({ blockhashValid: false, statusSlot: null });

    await inspectRingsSignature({
      env,
      signature: "sig",
      signedTxBase64: signedTxBase64(),
      rpc: { ...rpc, isBlockhashValid } as unknown as SolanaRpc,
    });

    // Never the `last_valid_block_height` column: that is a floor for a shield
    // and a merge, so using it to declare absence would void transactions that
    // were still perfectly alive.
    expect(isBlockhashValid).toHaveBeenCalledWith(BLOCKHASH, { commitment: "finalized" });
  });
});
