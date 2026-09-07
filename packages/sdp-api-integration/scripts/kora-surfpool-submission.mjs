const DEFAULT_STATUS_WAIT_MS = 3_000;
const DEFAULT_STATUS_POLL_MS = 250;

class ObservedTransactionError extends Error {}

/**
 * Build an idempotent sender for the local Kora-compatible Surfpool shim.
 *
 * A signed Solana transaction has a deterministic signature. That signature is
 * the idempotency key when an RPC timeout makes it unclear whether submission
 * succeeded. Concurrent requests for the same transaction share one broadcast,
 * and RPC errors are reconciled against getSignatureStatuses before surfacing.
 */
export function createIdempotentTransactionSubmitter({
  rpc,
  sendTimeoutMs,
  resubmissionTimeoutMs,
  statusWaitMs = DEFAULT_STATUS_WAIT_MS,
  statusPollMs = DEFAULT_STATUS_POLL_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  onWarning = console.warn,
}) {
  const inFlight = new Map();

  return function submitTransaction(signedTransaction, expectedSignature) {
    const existing = inFlight.get(expectedSignature);
    if (existing) return existing;

    const submission = sendTransaction({
      rpc,
      signedTransaction,
      expectedSignature,
      sendTimeoutMs,
      resubmissionTimeoutMs,
      statusWaitMs,
      statusPollMs,
      sleep,
      onWarning,
    }).finally(() => {
      if (inFlight.get(expectedSignature) === submission) {
        inFlight.delete(expectedSignature);
      }
    });

    inFlight.set(expectedSignature, submission);
    return submission;
  };
}

async function sendTransaction({
  rpc,
  signedTransaction,
  expectedSignature,
  sendTimeoutMs,
  resubmissionTimeoutMs,
  statusWaitMs,
  statusPollMs,
  sleep,
  onWarning,
}) {
  const params = [
    signedTransaction,
    {
      encoding: "base64",
      skipPreflight: true,
      preflightCommitment: "confirmed",
    },
  ];

  let signature;
  try {
    signature = await rpc("sendTransaction", params, { timeoutMs: sendTimeoutMs });
  } catch (error) {
    if (
      await transactionWasAccepted({
        rpc,
        expectedSignature,
        statusWaitMs,
        statusPollMs,
        sleep,
        onWarning,
      })
    ) {
      return expectedSignature;
    }
    throw error;
  }

  assertExpectedSignature(signature, expectedSignature);
  if (
    await transactionWasAccepted({
      rpc,
      expectedSignature,
      statusWaitMs,
      statusPollMs,
      sleep,
      onWarning,
    })
  ) {
    return expectedSignature;
  }

  onWarning(
    `Transaction ${expectedSignature} was not observed after ${statusWaitMs}ms; resubmitting.`
  );
  try {
    const resentSignature = await rpc("sendTransaction", params, {
      timeoutMs: resubmissionTimeoutMs,
    });
    assertExpectedSignature(resentSignature, expectedSignature);
    return expectedSignature;
  } catch (error) {
    if (
      await transactionWasAccepted({
        rpc,
        expectedSignature,
        statusWaitMs,
        statusPollMs,
        sleep,
        onWarning,
      })
    ) {
      return expectedSignature;
    }
    throw error;
  }
}

async function transactionWasAccepted({
  rpc,
  expectedSignature,
  statusWaitMs,
  statusPollMs,
  sleep,
  onWarning,
}) {
  const attempts = Math.max(1, Math.ceil(statusWaitMs / statusPollMs));

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const statuses = await rpc("getSignatureStatuses", [[expectedSignature]]);
      const status = statuses?.value?.[0];
      if (status) {
        if (status.err) {
          throw new ObservedTransactionError(
            `Transaction ${expectedSignature} failed: ${JSON.stringify(status.err)}`
          );
        }
        return true;
      }
    } catch (error) {
      if (error instanceof ObservedTransactionError) throw error;
      onWarning(`Could not reconcile transaction ${expectedSignature}.`, error);
    }

    if (attempt + 1 < attempts) await sleep(statusPollMs);
  }

  return false;
}

function assertExpectedSignature(actual, expected) {
  if (actual !== expected) {
    throw new Error(
      `Submitted transaction returned signature ${String(actual)}; expected ${expected}`
    );
  }
}
