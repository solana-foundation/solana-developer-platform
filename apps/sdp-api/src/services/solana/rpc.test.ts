import { SdpRpcError, solanaRpcError } from "@sdp/rpc/errors";
import {
  confirmTransaction,
  createRpc,
  type SolanaRpc,
  sendAndConfirmTransaction,
} from "@sdp/rpc/solana";
import { isTransientRpcError } from "@sdp/rpc/transient";
import type { RpcEnv } from "@sdp/rpc/types";
import { getBase64Codec, type Signature } from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { signedRingsTransaction } from "@/test/fixtures/rings-transactions";

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
 * A fake RPC that answers `getSignatureStatuses` from `send` and nothing else,
 * enough for `confirmTransaction`.
 */
function statusesRpc(send: ReturnType<typeof vi.fn>): SolanaRpc {
  // SAFETY: confirmTransaction calls only getSignatureStatuses(...).send(), which this
  // object provides; the rest of the SolanaRpc surface is never reached.
  return { getSignatureStatuses: vi.fn().mockReturnValue({ send }) } as unknown as SolanaRpc;
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

    const error = await captureRejection(
      confirmTransaction(rpc, TEST_SIGNATURE, { pollIntervalMs: 1, timeoutMs: 1 })
    );

    expect(error).toBeInstanceOf(SdpRpcError);
    const appError = error as SdpRpcError;
    expect(appError.code).toBe("SOLANA_RPC_ERROR");
    expect(appError.statusCode).toBe(502);
    expect(appError.message).toBe(`Transaction ${TEST_SIGNATURE} confirmation timed out after 1ms`);
    expect(getSignatureStatuses).toHaveBeenCalledWith([TEST_SIGNATURE]);
  });

  it("keeps waiting past an error seen only at processed (APE SOLA9-708)", async () => {
    const failure = { InstructionError: [0, { Custom: 1 }] };
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        value: [{ confirmationStatus: "processed", slot: 41n, err: failure }],
      })
      .mockResolvedValueOnce({
        value: [{ confirmationStatus: "confirmed", slot: 42n, err: null }],
      });
    const rpc = statusesRpc(send);

    const confirmation = await confirmTransaction(rpc, TEST_SIGNATURE, {
      pollIntervalMs: 1,
      timeoutMs: 10_000,
    });

    expect(confirmation).toMatchObject({ confirmationStatus: "confirmed", slot: 42n, err: null });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("returns an error once it reaches the commitment", async () => {
    const failure = { InstructionError: [0, { Custom: 1 }] };
    const send = vi
      .fn()
      .mockResolvedValue({ value: [{ confirmationStatus: "confirmed", slot: 42n, err: failure }] });
    const rpc = statusesRpc(send);

    const confirmation = await confirmTransaction(rpc, TEST_SIGNATURE, {
      pollIntervalMs: 1,
      timeoutMs: 10_000,
    });

    expect(confirmation.err).toEqual(failure);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe("sendAndConfirmTransaction", () => {
  it("throws a typed SOLANA_RPC_ERROR when the sent transaction never confirms", async () => {
    const { rpc, sendTransaction } = makePendingRpc(TEST_SIGNATURE);
    const { signedTxBase64 } = signedRingsTransaction(1);
    const signedTransaction = new Uint8Array(getBase64Codec().encode(signedTxBase64));

    const error = await captureRejection(
      sendAndConfirmTransaction(rpc, signedTransaction, { pollIntervalMs: 1, timeoutMs: 1 })
    );

    expect(error).toBeInstanceOf(SdpRpcError);
    const appError = error as SdpRpcError;
    expect(appError.code).toBe("SOLANA_RPC_ERROR");
    expect(appError.statusCode).toBe(502);
    expect(appError.message).toBe(`Transaction ${TEST_SIGNATURE} confirmation timed out after 1ms`);
    expect(sendTransaction).toHaveBeenCalledExactlyOnceWith(
      signedTxBase64,
      expect.objectContaining({ encoding: "base64" })
    );
  });
});

describe("confirmTransaction transient poll tolerance", () => {
  it("keeps polling through a transient poll failure and confirms", async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(solanaRpcError("RPC request timed out after 25ms"))
      .mockResolvedValueOnce({
        value: [{ confirmationStatus: "confirmed", slot: 42n, err: null }],
      });
    const rpc = { getSignatureStatuses: vi.fn().mockReturnValue({ send }) } as unknown as SolanaRpc;

    const confirmation = await confirmTransaction(rpc, TEST_SIGNATURE, {
      pollIntervalMs: 1,
      timeoutMs: 10_000,
    });

    expect(confirmation.confirmationStatus).toBe("confirmed");
    expect(confirmation.slot).toBe(42n);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("still propagates non-transient poll errors immediately", async () => {
    const send = vi.fn().mockRejectedValue(new Error("invalid params"));
    const rpc = { getSignatureStatuses: vi.fn().mockReturnValue({ send }) } as unknown as SolanaRpc;

    const error = await captureRejection(
      confirmTransaction(rpc, TEST_SIGNATURE, { pollIntervalMs: 1, timeoutMs: 10_000 })
    );

    expect((error as Error).message).toBe("invalid params");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("times out with the confirmation error when every poll fails transiently", async () => {
    const send = vi.fn().mockRejectedValue(solanaRpcError("RPC request timed out after 25ms"));
    const rpc = { getSignatureStatuses: vi.fn().mockReturnValue({ send }) } as unknown as SolanaRpc;

    const error = await captureRejection(
      confirmTransaction(rpc, TEST_SIGNATURE, { pollIntervalMs: 1, timeoutMs: 1 })
    );

    expect(error).toBeInstanceOf(SdpRpcError);
    expect((error as SdpRpcError).message).toBe(
      `Transaction ${TEST_SIGNATURE} confirmation timed out after 1ms`
    );
  });
});

describe("createRpc request timeout", () => {
  const TEST_ENV = { SOLANA_RPC_URL: "http://127.0.0.1:1" } as RpcEnv;

  /**
   * Fake fetch that behaves like a stalled server: the socket stays open and
   * nothing ever comes back. It honors AbortSignal the way real fetch does.
   */
  function stallingFetch(): typeof fetch {
    return vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    }) as unknown as typeof fetch;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects a stalled request with a transient-classified SOLANA_RPC_ERROR", async () => {
    vi.stubGlobal("fetch", stallingFetch());
    const rpc = createRpc(TEST_ENV, { requestTimeoutMs: 25 });

    const error = await captureRejection(rpc.getSlot().send());

    expect(error).toBeInstanceOf(SdpRpcError);
    const appError = error as SdpRpcError;
    expect(appError.code).toBe("SOLANA_RPC_ERROR");
    expect(appError.message).toBe("RPC request timed out after 25ms");
    expect(isTransientRpcError(appError)).toBe(true);
  });

  it("defers to a caller-supplied abortSignal instead of imposing its own deadline", async () => {
    vi.stubGlobal("fetch", stallingFetch());
    const rpc = createRpc(TEST_ENV, { requestTimeoutMs: 60_000 });

    const error = await captureRejection(
      rpc.getSlot().send({ abortSignal: AbortSignal.timeout(25) })
    );

    // The caller's abort surfaces as-is; our transport deadline must not rewrap it.
    expect(error).not.toBeInstanceOf(SdpRpcError);
  });
});
