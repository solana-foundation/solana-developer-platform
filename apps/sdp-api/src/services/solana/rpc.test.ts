import type { Signature } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import { confirmTransaction, type SolanaRpc, sendAndConfirmTransaction } from "./rpc";

const TEST_SIGNATURE = "5confirmTimeoutSig" as Signature;

/**
 * Fake RPC whose signature statuses never resolve past pending, so both
 * confirmation helpers exhaust their polling budget and time out.
 */
function makePendingRpc(signature: Signature): {
  rpc: SolanaRpc;
  getSignatureStatuses: ReturnType<typeof vi.fn>;
  sendTransaction: ReturnType<typeof vi.fn>;
} {
  const getSignatureStatuses = vi.fn().mockReturnValue({
    send: vi.fn().mockResolvedValue({ value: [null] }),
  });
  const sendTransaction = vi.fn().mockReturnValue({
    send: vi.fn().mockResolvedValue(signature),
  });
  return {
    rpc: { getSignatureStatuses, sendTransaction } as unknown as SolanaRpc,
    getSignatureStatuses,
    sendTransaction,
  };
}

/**
 * Await a promise that is expected to reject and hand back the rejection value.
 */
async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the promise to reject");
    },
    (error: unknown) => error
  );
}

describe("confirmTransaction", () => {
  it("throws a typed SOLANA_RPC_ERROR when confirmation never lands within the timeout", async () => {
    const { rpc, getSignatureStatuses } = makePendingRpc(TEST_SIGNATURE);

    const error = await captureRejection(confirmTransaction(rpc, TEST_SIGNATURE, { timeoutMs: 1 }));

    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.code).toBe("SOLANA_RPC_ERROR");
    expect(appError.statusCode).toBe(502);
    expect(appError.message).toBe(`Transaction ${TEST_SIGNATURE} confirmation timed out after 1ms`);
    expect(getSignatureStatuses).toHaveBeenCalledWith([TEST_SIGNATURE]);
  });
});

describe("sendAndConfirmTransaction", () => {
  it("throws a typed SOLANA_RPC_ERROR when the sent transaction never confirms", async () => {
    const { rpc, sendTransaction } = makePendingRpc(TEST_SIGNATURE);

    const error = await captureRejection(
      sendAndConfirmTransaction(rpc, new Uint8Array([1, 2, 3]), { timeoutMs: 1 })
    );

    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.code).toBe("SOLANA_RPC_ERROR");
    expect(appError.statusCode).toBe(502);
    expect(appError.message).toBe(`Transaction ${TEST_SIGNATURE} confirmation timed out after 1ms`);
    expect(sendTransaction).toHaveBeenCalledTimes(1);
  });
});
