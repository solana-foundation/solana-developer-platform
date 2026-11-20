import { RpcTimeoutError } from "@sdp/rpc/errors";
import * as solanaRpc from "@sdp/rpc/solana";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaymentsRepository, PaymentTransferRow } from "@/db/repositories/payments.repository";
import type {
  OwnedSubmissionLifecycle,
  SponsorshipFeePayment,
} from "@/services/sponsorship.service";
import {
  SubmissionNotStartedError,
  submitSponsoredTransaction,
} from "@/services/sponsorship-submission";
import { syntheticSignature } from "@/test/helpers/parsed-transactions";
import { fetchFailedError, sendTransactionPreflightError } from "@/test/helpers/rpc-errors";
import { createTransferSignedSubmissionStore } from "./signed-submission";

const SIGNATURE = syntheticSignature(1);
const SIGNED_TRANSACTION = new Uint8Array([1, 2, 3]);

function fakeStore() {
  return {
    persistSigned: vi.fn().mockResolvedValue(undefined),
    markStarted: vi.fn().mockResolvedValue(undefined),
    hasStarted: vi.fn().mockResolvedValue(true),
    clearSigned: vi.fn().mockResolvedValue(undefined),
  };
}

/** A sponsor that runs the durable lifecycle before handing back the signed bytes. */
function fakeSponsor(release = vi.fn().mockResolvedValue(undefined)) {
  const prepareOwnedSubmission = vi.fn(
    async (_transaction: Uint8Array, lifecycle: OwnedSubmissionLifecycle) => {
      await lifecycle.persistSigned({
        signedTransaction: SIGNED_TRANSACTION,
        signature: SIGNATURE,
      });
      await lifecycle.markStarted();
      return {
        signedTransaction: SIGNED_TRANSACTION,
        signature: SIGNATURE,
        releaseDefinitelyUnbroadcast: release,
      };
    }
  );
  const unused = () => Promise.reject(new Error("Only the owned submission path is exercised"));
  const feePayment: SponsorshipFeePayment = {
    providerId: "test-sponsor",
    getFeePayer: unused,
    signAsFeePayer: unused,
    getSponsorshipConfiguration: unused,
    prepareOwnedSubmission,
  };
  return { feePayment, prepareOwnedSubmission, release };
}

function submit(feePayment: SponsorshipFeePayment, store: ReturnType<typeof fakeStore>) {
  return submitSponsoredTransaction({
    feePayment,
    // SAFETY: `sendTransaction` is spied in every test, so the client is never read.
    rpc: {} as solanaRpc.SolanaRpc,
    transaction: new Uint8Array([9]),
    lastValidBlockHeight: 123n,
    store,
  });
}

describe("submitSponsoredTransaction", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("broadcasts the exact signed bytes only after they are persisted and marked started", async () => {
    const order: string[] = [];
    const store = fakeStore();
    store.persistSigned.mockImplementation(async () => {
      order.push("persisted");
    });
    store.markStarted.mockImplementation(async () => {
      order.push("started");
    });
    const send = vi.spyOn(solanaRpc, "sendTransaction").mockImplementation(async () => {
      order.push("sent");
      return SIGNATURE;
    });

    await expect(submit(fakeSponsor().feePayment, store)).resolves.toBe(SIGNATURE);

    expect(order).toEqual(["persisted", "started", "sent"]);
    expect(store.persistSigned).toHaveBeenCalledExactlyOnceWith({
      signature: SIGNATURE,
      signedTransaction: "AQID",
      lastValidBlockHeight: "123",
    });
    expect(send).toHaveBeenCalledExactlyOnceWith({}, SIGNED_TRANSACTION);
  });

  it("retries a transient broadcast with the same signed bytes, never re-signing", async () => {
    vi.useFakeTimers();
    const store = fakeStore();
    const sponsor = fakeSponsor();
    const send = vi
      .spyOn(solanaRpc, "sendTransaction")
      .mockRejectedValueOnce(fetchFailedError())
      .mockResolvedValueOnce(SIGNATURE);

    const result = submit(sponsor.feePayment, store);
    await vi.runAllTimersAsync();

    await expect(result).resolves.toBe(SIGNATURE);
    expect(send.mock.calls.map(([, bytes]) => bytes)).toEqual([
      SIGNED_TRANSACTION,
      SIGNED_TRANSACTION,
    ]);
    expect(sponsor.prepareOwnedSubmission).toHaveBeenCalledOnce();
    expect(store.persistSigned).toHaveBeenCalledOnce();
    expect(store.markStarted).toHaveBeenCalledOnce();
  });

  it("fails a first-attempt preflight rejection, releasing the sponsor and forgetting the signature", async () => {
    const store = fakeStore();
    const sponsor = fakeSponsor();
    const refusal = sendTransactionPreflightError(42);
    const programError = refusal.cause;
    if (!(programError instanceof Error)) throw new Error("Expected the refusal's program error");
    vi.spyOn(solanaRpc, "sendTransaction").mockRejectedValueOnce(refusal);

    await expect(submit(sponsor.feePayment, store)).rejects.toMatchObject({
      code: "TRANSACTION_FAILED",
      message: programError.message,
      cause: refusal,
    });

    expect(sponsor.release).toHaveBeenCalledExactlyOnceWith(refusal);
    expect(store.clearSigned).toHaveBeenCalledExactlyOnceWith(SIGNATURE);
  });

  it("still fails and forgets the signature when releasing the sponsor fails", async () => {
    const store = fakeStore();
    const sponsor = fakeSponsor(vi.fn().mockRejectedValue(new Error("release failed")));
    vi.spyOn(solanaRpc, "sendTransaction").mockRejectedValueOnce(sendTransactionPreflightError());

    await expect(submit(sponsor.feePayment, store)).rejects.toMatchObject({
      code: "TRANSACTION_FAILED",
    });

    expect(store.clearSigned).toHaveBeenCalledExactlyOnceWith(SIGNATURE);
  });

  it("does not retry a preflight rejection whose program log reads as transient", async () => {
    vi.useFakeTimers();
    const store = fakeStore();
    const sponsor = fakeSponsor();
    const refusal = sendTransactionPreflightError(undefined, [
      "Program log: Error: oracle price timed out",
    ]);
    const send = vi.spyOn(solanaRpc, "sendTransaction").mockRejectedValue(refusal);

    const result = expect(submit(sponsor.feePayment, store)).rejects.toMatchObject({
      code: "TRANSACTION_FAILED",
      message: "Program log: Error: oracle price timed out",
    });
    await vi.runAllTimersAsync();

    await result;
    expect(send).toHaveBeenCalledOnce();
    expect(sponsor.release).toHaveBeenCalledExactlyOnceWith(refusal);
    expect(store.clearSigned).toHaveBeenCalledExactlyOnceWith(SIGNATURE);
  });

  it("answers ACCOUNT_FROZEN for a frozen-account preflight rejection, as definitely unbroadcast", async () => {
    const store = fakeStore();
    const sponsor = fakeSponsor();
    const refusal = sendTransactionPreflightError(17);
    vi.spyOn(solanaRpc, "sendTransaction").mockRejectedValueOnce(refusal);

    await expect(submit(sponsor.feePayment, store)).rejects.toMatchObject({
      code: "ACCOUNT_FROZEN",
      cause: refusal,
    });

    expect(sponsor.release).toHaveBeenCalledExactlyOnceWith(refusal);
    expect(store.clearSigned).toHaveBeenCalledExactlyOnceWith(SIGNATURE);
  });

  it("keeps the outcome ambiguous when a retry after a transient failure looks deterministic", async () => {
    vi.useFakeTimers();
    const store = fakeStore();
    const sponsor = fakeSponsor();
    const refusal = sendTransactionPreflightError();
    vi.spyOn(solanaRpc, "sendTransaction")
      .mockRejectedValueOnce(new RpcTimeoutError(25))
      .mockRejectedValueOnce(refusal);

    const result = expect(submit(sponsor.feePayment, store)).rejects.toMatchObject({
      message: "Solana RPC submission outcome is ambiguous after a transient failure",
      cause: refusal,
    });
    await vi.runAllTimersAsync();

    await result;
    expect(sponsor.release).not.toHaveBeenCalled();
    expect(store.clearSigned).not.toHaveBeenCalled();
  });

  it("returns the final transient error after retry exhaustion, keeping the signature", async () => {
    vi.useFakeTimers();
    const store = fakeStore();
    const finalError = new RpcTimeoutError(25);
    const send = vi
      .spyOn(solanaRpc, "sendTransaction")
      .mockRejectedValueOnce(new RpcTimeoutError(25))
      .mockRejectedValueOnce(new RpcTimeoutError(25))
      .mockRejectedValueOnce(new RpcTimeoutError(25))
      .mockRejectedValueOnce(finalError);

    const result = expect(submit(fakeSponsor().feePayment, store)).rejects.toBe(finalError);
    await vi.runAllTimersAsync();

    await result;
    expect(send.mock.calls.every(([, bytes]) => bytes === SIGNED_TRANSACTION)).toBe(true);
    expect(store.clearSigned).not.toHaveBeenCalled();
  });

  it("reports a definite never-started submission without sending when the start marker write fails", async () => {
    const markerError = new Error("marker response lost");
    const store = fakeStore();
    store.markStarted.mockRejectedValue(markerError);
    const send = vi.spyOn(solanaRpc, "sendTransaction").mockResolvedValue(SIGNATURE);

    const outcome = submit(fakeSponsor().feePayment, store);

    await expect(outcome).rejects.toBeInstanceOf(SubmissionNotStartedError);
    await expect(outcome).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      cause: markerError,
    });
    expect(send).not.toHaveBeenCalled();
  });
});

describe("createTransferSignedSubmissionStore", () => {
  // SAFETY: the store reads only the transfer's id and tenant, and hands rows back unread.
  const transfer = {
    id: "xfr_signed_submission_test",
    organization_id: "org_signed_submission_test",
    project_id: "prj_signed_submission_test",
  } as PaymentTransferRow;
  const transferKey = {
    transferId: transfer.id,
    organizationId: transfer.organization_id,
    projectId: transfer.project_id,
  };
  // SAFETY: as above, the store returns these rows without reading their other columns.
  const signedRow = {
    ...transfer,
    signature: SIGNATURE,
    signed_transaction: "AQID",
    last_valid_block_height: "123",
    submission_started_at: null,
  } as PaymentTransferRow;
  const startedRow = {
    ...signedRow,
    submission_started_at: "2026-11-20T00:00:00.000Z",
  } as PaymentTransferRow;

  function createRepository() {
    return {
      persistSignedTransfer: vi
        .fn<PaymentsRepository["persistSignedTransfer"]>()
        .mockResolvedValue(signedRow),
      markTransferSubmissionStarted: vi.fn<PaymentsRepository["markTransferSubmissionStarted"]>(),
      getTransferById: vi.fn<PaymentsRepository["getTransferById"]>(),
    };
  }

  async function persistedStore(repository: ReturnType<typeof createRepository>) {
    const used: Pick<
      PaymentsRepository,
      "persistSignedTransfer" | "markTransferSubmissionStarted" | "getTransferById"
    > = repository;
    // SAFETY: the store calls only these three repository methods.
    const store = createTransferSignedSubmissionStore(used as PaymentsRepository, transfer);
    await store.persistSigned({
      signature: SIGNATURE,
      signedTransaction: "AQID",
      lastValidBlockHeight: "123",
    });
    return store;
  }

  it("persists the signed transfer and exposes it only once submission has started", async () => {
    const repository = createRepository();
    repository.markTransferSubmissionStarted.mockResolvedValue(startedRow);
    const store = await persistedStore(repository);

    expect(repository.persistSignedTransfer).toHaveBeenCalledExactlyOnceWith({
      ...transferKey,
      signature: SIGNATURE,
      signedTransaction: "AQID",
      lastValidBlockHeight: "123",
      updatedAt: expect.any(String),
    });
    await expect(store.submittedRow()).resolves.toBeNull();

    await store.markStarted();

    expect(repository.markTransferSubmissionStarted).toHaveBeenCalledExactlyOnceWith({
      ...transferKey,
      startedAt: expect.any(String),
    });
    await expect(store.submittedRow()).resolves.toBe(startedRow);
  });

  it("retains the signed row when the start-marker result is unknown", async () => {
    const repository = createRepository();
    repository.markTransferSubmissionStarted.mockResolvedValue(null);
    repository.getTransferById.mockResolvedValue(signedRow);
    const store = await persistedStore(repository);

    await expect(store.markStarted()).rejects.toThrow("submission was not started");
    await expect(store.submittedRow()).resolves.toBe(signedRow);

    await expect(store.hasStarted()).resolves.toBe(false);
    await expect(store.submittedRow()).resolves.toBeNull();
  });

  it("stays conservative when both the marker write and authoritative read fail", async () => {
    const repository = createRepository();
    repository.markTransferSubmissionStarted.mockRejectedValue(new Error("marker response lost"));
    repository.getTransferById.mockRejectedValue(new Error("read failed"));
    const store = await persistedStore(repository);

    await expect(store.markStarted()).rejects.toThrow("marker response lost");
    await expect(store.hasStarted()).rejects.toThrow("read failed");
    await expect(store.submittedRow()).resolves.toBe(signedRow);
  });
});
