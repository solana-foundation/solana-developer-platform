import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createIdempotentTransactionSubmitter } from "../packages/sdp-api-integration/scripts/kora-surfpool-submission.mjs";

const SIGNATURE = "signature";

function createSubmitter(rpc) {
  return createIdempotentTransactionSubmitter({
    rpc,
    sendTimeoutMs: 30,
    resubmissionTimeoutMs: 10,
    statusWaitMs: 1,
    statusPollMs: 1,
    sleep: async () => {},
    onWarning: () => {},
  });
}

describe("Kora Surfpool idempotent submission", () => {
  it("recovers an already-processed response when the signature landed", async () => {
    const calls = [];
    const submit = createSubmitter(async (method) => {
      calls.push(method);
      if (method === "sendTransaction")
        throw new Error("This transaction has already been processed");
      return { value: [{ err: null, confirmationStatus: "processed" }] };
    });

    await assert.doesNotReject(submit("signed-transaction", SIGNATURE));
    assert.deepEqual(calls, ["sendTransaction", "getSignatureStatuses"]);
  });

  it("surfaces the original submission error when the signature never appears", async () => {
    const submit = createSubmitter(async (method) => {
      if (method === "sendTransaction") throw new Error("send timed out");
      return { value: [null] };
    });

    await assert.rejects(submit("signed-transaction", SIGNATURE), /send timed out/);
  });

  it("surfaces an observed on-chain transaction error", async () => {
    const submit = createSubmitter(async (method) => {
      if (method === "sendTransaction") throw new Error("send timed out");
      return { value: [{ err: { InstructionError: [0, "Custom"] } }] };
    });

    await assert.rejects(submit("signed-transaction", SIGNATURE), /InstructionError/);
  });

  it("reconciles an already-processed resubmission", async () => {
    let sends = 0;
    let statusReads = 0;
    const submit = createSubmitter(async (method) => {
      if (method === "sendTransaction") {
        sends += 1;
        if (sends === 1) return SIGNATURE;
        throw new Error("This transaction has already been processed");
      }
      statusReads += 1;
      return { value: [statusReads === 1 ? null : { err: null }] };
    });

    await assert.doesNotReject(submit("signed-transaction", SIGNATURE));
    assert.equal(sends, 2);
    assert.equal(statusReads, 2);
  });

  it("coalesces concurrent submissions for the same signature", async () => {
    let sends = 0;
    let releaseSend;
    const pendingSend = new Promise((resolve) => {
      releaseSend = resolve;
    });
    const submit = createSubmitter(async (method) => {
      if (method === "sendTransaction") {
        sends += 1;
        await pendingSend;
        return SIGNATURE;
      }
      return { value: [{ err: null }] };
    });

    const first = submit("signed-transaction", SIGNATURE);
    const second = submit("signed-transaction", SIGNATURE);
    releaseSend();

    assert.equal(await first, SIGNATURE);
    assert.equal(await second, SIGNATURE);
    assert.equal(sends, 1);
  });
});
