import * as solanaRpc from "@sdp/rpc/solana";
import {
  type Signature,
  SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SolanaError,
} from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaymentsRepository, PaymentTransferRow } from "@/db/repositories/payments.repository";
import type { SponsorshipFeePayment } from "@/services/sponsorship.service";
import { submitSponsoredTransaction } from "@/services/sponsorship-submission";
import { createTransferSignedSubmissionStore } from "./signed-submission";

const SIGNATURE =
  "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy" as Signature;

function preflightError(cause?: unknown, logs?: string[]) {
  return new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, {
    accounts: null,
    fee: null,
    loadedAccountsDataSize: null,
    loadedAddresses: null,
    logs: null,
    postBalances: null,
    postTokenBalances: null,
    preBalances: null,
    preTokenBalances: null,
    replacementBlockhash: null,
    returnData: null,
    unitsConsumed: null,
    ...(cause === undefined ? {} : { cause }),
    ...(logs === undefined ? {} : { logs }),
  });
}

describe("submitSponsoredTransaction", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("broadcasts the exact bytes only after the durable lifecycle completes", async () => {
    const order: string[] = [];
    const signedTransaction = new Uint8Array([1, 2, 3]);
    const feePayment = {
      prepareOwnedSubmission: vi.fn(async (_transaction, lifecycle) => {
        await lifecycle.persistSigned({ signedTransaction, signature: SIGNATURE });
        await lifecycle.markStarted();
        order.push("prepared");
        return { signedTransaction, signature: SIGNATURE };
      }),
    } as unknown as SponsorshipFeePayment;
    const store = {
      persistSigned: vi.fn(async () => {
        order.push("persisted");
      }),
      markStarted: vi.fn(async () => {
        order.push("started");
      }),
      hasStarted: vi.fn().mockResolvedValue(true),
      clearSigned: vi.fn(),
    };
    const send = vi.spyOn(solanaRpc, "sendTransaction").mockImplementation(async (_rpc, bytes) => {
      order.push("sent");
      expect(bytes).toEqual(signedTransaction);
      return SIGNATURE;
    });

    await expect(
      submitSponsoredTransaction({
        feePayment,
        rpc: {} as solanaRpc.SolanaRpc,
        transaction: new Uint8Array([9]),
        lastValidBlockHeight: 123n,
        store,
      })
    ).resolves.toBe(SIGNATURE);

    expect(order).toEqual(["persisted", "started", "prepared", "sent"]);
    expect(store.persistSigned).toHaveBeenCalledWith({
      signature: SIGNATURE,
      signedTransaction: "AQID",
      lastValidBlockHeight: "123",
    });
    expect(send).toHaveBeenCalledOnce();
  });

  it("retries transient broadcasts with the exact same signed bytes", async () => {
    vi.useFakeTimers();
    const signedTransaction = new Uint8Array([1, 2, 3]);
    const feePayment = {
      prepareOwnedSubmission: vi.fn(async (_transaction, lifecycle) => {
        await lifecycle.persistSigned({ signedTransaction, signature: SIGNATURE });
        await lifecycle.markStarted();
        return { signedTransaction, signature: SIGNATURE };
      }),
    } as unknown as SponsorshipFeePayment;
    const store = {
      persistSigned: vi.fn().mockResolvedValue(undefined),
      markStarted: vi.fn().mockResolvedValue(undefined),
      hasStarted: vi.fn().mockResolvedValue(true),
      clearSigned: vi.fn(),
    };
    const send = vi
      .spyOn(solanaRpc, "sendTransaction")
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce(SIGNATURE);

    const result = submitSponsoredTransaction({
      feePayment,
      rpc: {} as solanaRpc.SolanaRpc,
      transaction: new Uint8Array([9]),
      lastValidBlockHeight: 123n,
      store,
    });
    await vi.runAllTimersAsync();

    await expect(result).resolves.toBe(SIGNATURE);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[1]).toBe(signedTransaction);
    expect(send.mock.calls[1]?.[1]).toBe(signedTransaction);
    expect(feePayment.prepareOwnedSubmission).toHaveBeenCalledOnce();
    expect(store.persistSigned).toHaveBeenCalledOnce();
    expect(store.markStarted).toHaveBeenCalledOnce();
  });

  it("fails and releases a first-attempt preflight rejection", async () => {
    const signedTransaction = new Uint8Array([1, 2, 3]);
    const releaseDefinitelyUnbroadcast = vi.fn().mockResolvedValue(undefined);
    const feePayment = {
      prepareOwnedSubmission: vi.fn(async () => ({
        signedTransaction,
        signature: SIGNATURE,
        releaseDefinitelyUnbroadcast,
      })),
    } as unknown as SponsorshipFeePayment;
    const store = {
      persistSigned: vi.fn(),
      markStarted: vi.fn(),
      hasStarted: vi.fn(),
      clearSigned: vi.fn(),
    };
    const cause = new SolanaError(SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM, {
      code: 42,
      index: 0,
    });
    const error = preflightError(cause);
    vi.spyOn(solanaRpc, "sendTransaction").mockRejectedValueOnce(error);

    await expect(
      submitSponsoredTransaction({
        feePayment,
        rpc: {} as solanaRpc.SolanaRpc,
        transaction: new Uint8Array([9]),
        lastValidBlockHeight: 123n,
        store,
      })
    ).rejects.toMatchObject({ code: "TRANSACTION_FAILED", message: cause.message });

    expect(releaseDefinitelyUnbroadcast).toHaveBeenCalledWith(error);
    expect(store.clearSigned).toHaveBeenCalledExactlyOnceWith(SIGNATURE);
  });

  it("forgets the signed transaction when releasing a preflight rejection fails", async () => {
    const feePayment = {
      prepareOwnedSubmission: vi.fn(async () => ({
        signedTransaction: new Uint8Array([1, 2, 3]),
        signature: SIGNATURE,
        releaseDefinitelyUnbroadcast: vi.fn().mockRejectedValue(new Error("release failed")),
      })),
    } as unknown as SponsorshipFeePayment;
    const store = {
      persistSigned: vi.fn(),
      markStarted: vi.fn(),
      hasStarted: vi.fn(),
      clearSigned: vi.fn(),
    };
    vi.spyOn(solanaRpc, "sendTransaction").mockRejectedValueOnce(preflightError());

    await expect(
      submitSponsoredTransaction({
        feePayment,
        rpc: {} as solanaRpc.SolanaRpc,
        transaction: new Uint8Array([9]),
        lastValidBlockHeight: 123n,
        store,
      })
    ).rejects.toMatchObject({ code: "TRANSACTION_FAILED" });

    expect(store.clearSigned).toHaveBeenCalledExactlyOnceWith(SIGNATURE);
  });

  it("does not retry a preflight rejection whose program log reads as transient", async () => {
    vi.useFakeTimers();
    const releaseDefinitelyUnbroadcast = vi.fn().mockResolvedValue(undefined);
    const feePayment = {
      prepareOwnedSubmission: vi.fn(async () => ({
        signedTransaction: new Uint8Array([1, 2, 3]),
        signature: SIGNATURE,
        releaseDefinitelyUnbroadcast,
      })),
    } as unknown as SponsorshipFeePayment;
    const store = {
      persistSigned: vi.fn(),
      markStarted: vi.fn(),
      hasStarted: vi.fn(),
      clearSigned: vi.fn(),
    };
    const error = preflightError(undefined, ["Program log: Error: oracle price timed out"]);
    const send = vi.spyOn(solanaRpc, "sendTransaction").mockRejectedValue(error);

    const result = expect(
      submitSponsoredTransaction({
        feePayment,
        rpc: {} as solanaRpc.SolanaRpc,
        transaction: new Uint8Array([9]),
        lastValidBlockHeight: 123n,
        store,
      })
    ).rejects.toMatchObject({ code: "TRANSACTION_FAILED" });
    await vi.runAllTimersAsync();

    await result;
    expect(send).toHaveBeenCalledOnce();
    expect(releaseDefinitelyUnbroadcast).toHaveBeenCalledExactlyOnceWith(error);
    expect(store.clearSigned).toHaveBeenCalledExactlyOnceWith(SIGNATURE);
  });

  it("maps an account-frozen preflight rejection without losing definiteness", async () => {
    const signedTransaction = new Uint8Array([1, 2, 3]);
    const releaseDefinitelyUnbroadcast = vi.fn().mockResolvedValue(undefined);
    const feePayment = {
      prepareOwnedSubmission: vi.fn(async () => ({
        signedTransaction,
        signature: SIGNATURE,
        releaseDefinitelyUnbroadcast,
      })),
    } as unknown as SponsorshipFeePayment;
    const store = {
      persistSigned: vi.fn(),
      markStarted: vi.fn(),
      hasStarted: vi.fn(),
      clearSigned: vi.fn(),
    };
    vi.spyOn(solanaRpc, "sendTransaction").mockRejectedValueOnce(
      preflightError(
        new SolanaError(SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM, { code: 17, index: 0 })
      )
    );

    await expect(
      submitSponsoredTransaction({
        feePayment,
        rpc: {} as solanaRpc.SolanaRpc,
        transaction: new Uint8Array([9]),
        lastValidBlockHeight: 123n,
        store,
      })
    ).rejects.toMatchObject({ code: "ACCOUNT_FROZEN" });
  });

  it("keeps the result ambiguous when a later retry looks deterministic", async () => {
    vi.useFakeTimers();
    const signedTransaction = new Uint8Array([1, 2, 3]);
    const deterministicError = preflightError();
    const releaseDefinitelyUnbroadcast = vi.fn().mockResolvedValue(undefined);
    const feePayment = {
      prepareOwnedSubmission: vi.fn(async (_transaction, lifecycle) => {
        await lifecycle.persistSigned({ signedTransaction, signature: SIGNATURE });
        await lifecycle.markStarted();
        return { signedTransaction, signature: SIGNATURE, releaseDefinitelyUnbroadcast };
      }),
    } as unknown as SponsorshipFeePayment;
    const store = {
      persistSigned: vi.fn().mockResolvedValue(undefined),
      markStarted: vi.fn().mockResolvedValue(undefined),
      hasStarted: vi.fn().mockResolvedValue(true),
      clearSigned: vi.fn(),
    };
    vi.spyOn(solanaRpc, "sendTransaction")
      .mockRejectedValueOnce(new Error("RPC timed out"))
      .mockRejectedValueOnce(deterministicError);

    const result = expect(
      submitSponsoredTransaction({
        feePayment,
        rpc: {} as solanaRpc.SolanaRpc,
        transaction: new Uint8Array([9]),
        lastValidBlockHeight: 123n,
        store,
      })
    ).rejects.toMatchObject({
      message: "Solana RPC submission outcome is ambiguous after a transient failure",
      cause: deterministicError,
    });
    await vi.runAllTimersAsync();

    await result;
    expect(releaseDefinitelyUnbroadcast).not.toHaveBeenCalled();
    expect(store.clearSigned).not.toHaveBeenCalled();
  });

  it("returns the final transient error after retry exhaustion", async () => {
    vi.useFakeTimers();
    const signedTransaction = new Uint8Array([1, 2, 3]);
    const finalError = new Error("RPC timed out for the fourth time");
    const feePayment = {
      prepareOwnedSubmission: vi.fn(async () => ({
        signedTransaction,
        signature: SIGNATURE,
      })),
    } as unknown as SponsorshipFeePayment;
    const store = {
      persistSigned: vi.fn(),
      markStarted: vi.fn(),
      hasStarted: vi.fn(),
      clearSigned: vi.fn(),
    };
    const send = vi
      .spyOn(solanaRpc, "sendTransaction")
      .mockRejectedValueOnce(new Error("RPC timed out"))
      .mockRejectedValueOnce(new Error("RPC timed out again"))
      .mockRejectedValueOnce(new Error("RPC timed out for the third time"))
      .mockRejectedValueOnce(finalError);

    const result = expect(
      submitSponsoredTransaction({
        feePayment,
        rpc: {} as solanaRpc.SolanaRpc,
        transaction: new Uint8Array([9]),
        lastValidBlockHeight: 123n,
        store,
      })
    ).rejects.toBe(finalError);
    await vi.runAllTimersAsync();

    await result;
    expect(send).toHaveBeenCalledTimes(4);
    expect(send.mock.calls.every(([, bytes]) => bytes === signedTransaction)).toBe(true);
    expect(store.clearSigned).not.toHaveBeenCalled();
  });
});

describe("createTransferSignedSubmissionStore", () => {
  const transfer = {
    id: "xfr_signed_submission_test",
    organization_id: "org_signed_submission_test",
    project_id: "prj_signed_submission_test",
  } as PaymentTransferRow;
  const signedRow = {
    ...transfer,
    signature: SIGNATURE,
    signed_transaction: "AQID",
    last_valid_block_height: "123",
    submission_started_at: null,
  } as PaymentTransferRow;

  function createRepository() {
    return {
      persistSignedTransfer: vi.fn().mockResolvedValue(signedRow),
      markTransferSubmissionStarted: vi.fn(),
      getTransferById: vi.fn(),
    };
  }

  function createStore(repository = createRepository()) {
    return createTransferSignedSubmissionStore(
      repository as unknown as PaymentsRepository,
      transfer
    );
  }

  it("does not expose signed bytes before submission starts", async () => {
    const store = createStore();

    await store.persistSigned({
      signature: SIGNATURE,
      signedTransaction: "AQID",
      lastValidBlockHeight: "123",
    });

    await expect(store.submittedRow()).resolves.toBeNull();
  });

  it("retains the signed row when the start-marker result is unknown", async () => {
    const repository = createRepository();
    repository.markTransferSubmissionStarted.mockResolvedValue(null);
    repository.getTransferById.mockResolvedValue(signedRow);
    const store = createStore(repository);
    await store.persistSigned({
      signature: SIGNATURE,
      signedTransaction: "AQID",
      lastValidBlockHeight: "123",
    });

    await expect(store.markStarted()).rejects.toThrow("submission was not started");
    await expect(store.submittedRow()).resolves.toBe(signedRow);

    await expect(store.hasStarted()).resolves.toBe(false);
    await expect(store.submittedRow()).resolves.toBeNull();
  });

  it("stays conservative when both the marker write and authoritative read fail", async () => {
    const repository = createRepository();
    repository.markTransferSubmissionStarted.mockRejectedValue(new Error("marker response lost"));
    repository.getTransferById.mockRejectedValue(new Error("read failed"));
    const store = createStore(repository);
    await store.persistSigned({
      signature: SIGNATURE,
      signedTransaction: "AQID",
      lastValidBlockHeight: "123",
    });

    await expect(store.markStarted()).rejects.toThrow("marker response lost");
    await expect(store.hasStarted()).rejects.toThrow("read failed");
    await expect(store.submittedRow()).resolves.toBe(signedRow);
  });
});
