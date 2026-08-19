import { describe, expect, it, vi } from "vitest";
import type { PaymentTransferRow } from "@/db/repositories/payments.repository";
import { createSubmissionRecorder } from "./transfers";

const SIGNATURE =
  "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuWJ5NFkqjAvuA3P73N5MtZ7e8KQLD6tPBm53RsNkUqJZiy";

const transfer = {
  id: "tr_recorder_test",
  status: "processing",
  signature: null,
} as unknown as PaymentTransferRow;

describe("createSubmissionRecorder", () => {
  it("returns the persisted row when the in-flight signature write succeeded", async () => {
    const persisted = { ...transfer, signature: SIGNATURE };
    const persist = vi.fn().mockResolvedValue(persisted);
    const recorder = createSubmissionRecorder(transfer, persist);

    await recorder.onSubmitted(SIGNATURE);

    expect(await recorder.submittedRow()).toBe(persisted);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("retries a failed signature write before reporting the submission", async () => {
    const persisted = { ...transfer, signature: SIGNATURE };
    const persist = vi
      .fn()
      .mockRejectedValueOnce(new Error("db unavailable"))
      .mockResolvedValueOnce(persisted);
    const recorder = createSubmissionRecorder(transfer, persist);

    await recorder.onSubmitted(SIGNATURE);

    expect(await recorder.submittedRow()).toBe(persisted);
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it("retries at submission even when the caller never reads the row", async () => {
    const persisted = { ...transfer, signature: SIGNATURE };
    const persist = vi
      .fn()
      .mockRejectedValueOnce(new Error("db unavailable"))
      .mockResolvedValueOnce(persisted);
    const recorder = createSubmissionRecorder(transfer, persist);

    await recorder.onSubmitted(SIGNATURE);

    // A caller that decides something from the write's outcome — the batch
    // path parks the chunk on it — must see both attempts before it decides.
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it("falls back to the in-memory signed row when persistence keeps failing", async () => {
    const persist = vi.fn().mockRejectedValue(new Error("db unavailable"));
    const recorder = createSubmissionRecorder(transfer, persist);

    await recorder.onSubmitted(SIGNATURE);

    // A broadcast transaction must never surface as unsigned `failed` — the
    // caller gets the signed processing row even if both writes were lost.
    expect(await recorder.submittedRow()).toMatchObject({
      id: transfer.id,
      status: "processing",
      signature: SIGNATURE,
    });
    expect(persist).toHaveBeenCalledTimes(2);
  });

  it("reports nothing when the transaction was never submitted", async () => {
    const persist = vi.fn();
    const recorder = createSubmissionRecorder(transfer, persist);

    expect(await recorder.submittedRow()).toBeNull();
    expect(persist).not.toHaveBeenCalled();
  });
});
