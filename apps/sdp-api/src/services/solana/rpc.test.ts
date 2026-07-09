import type { RpcEnv } from "@sdp/rpc";
import { isTransientRpcError } from "@sdp/rpc";
import { SdpRpcError, solanaRpcError } from "@sdp/rpc/errors";
import {
  confirmTransaction,
  createRpc,
  type SolanaRpc,
  sendAndConfirmTransaction,
} from "@sdp/rpc/solana";
import type { Signature } from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";

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
});

describe("sendAndConfirmTransaction", () => {
  it("throws a typed SOLANA_RPC_ERROR when the sent transaction never confirms", async () => {
    const { rpc, sendTransaction } = makePendingRpc(TEST_SIGNATURE);

    const error = await captureRejection(
      sendAndConfirmTransaction(rpc, new Uint8Array([1, 2, 3]), { pollIntervalMs: 1, timeoutMs: 1 })
    );

    expect(error).toBeInstanceOf(SdpRpcError);
    const appError = error as SdpRpcError;
    expect(appError.code).toBe("SOLANA_RPC_ERROR");
    expect(appError.statusCode).toBe(502);
    expect(appError.message).toBe(`Transaction ${TEST_SIGNATURE} confirmation timed out after 1ms`);
    expect(sendTransaction).toHaveBeenCalledTimes(1);
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
