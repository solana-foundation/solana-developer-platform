import { DEFAULT_SDP_API_URL, type EarnStrategy } from "@sdp/types";

export function earnButtonIntegrationPath(publicToken: string): string {
  return `/embedded-yield/integrate/${encodeURIComponent(publicToken)}`;
}

/**
 * The complete B2B2C loop, exactly as shipped (PRO-1722 + PRO-1772): the
 * partner's backend BUILDS an unsigned transaction for the customer's own
 * wallet, the wallet signs it in the browser, the backend SUBMITS the signed
 * bytes — SDP verifies the signature, records the movement, then broadcasts —
 * and the reads close the loop: poll the movement to a terminal state, show
 * balance + earned, list activity, and withdraw the same way money came in.
 *
 * A server-only example by construction: the API key comes from process.env
 * and the browser/mobile button is expected to call this partner-owned
 * backend. The customer's key never leaves their wallet, and the partner's
 * key never reaches the browser. Callers that know the deployment's real API
 * base (the handoff page resolves one for its own fetch) pass it so the
 * snippet targets the same host.
 */
export function buildEarnServerIntegration(
  strategy: Pick<EarnStrategy, "id">,
  apiBaseUrl?: string
): string {
  return `const SDP_API_URL = ${JSON.stringify(apiBaseUrl ?? DEFAULT_SDP_API_URL)};

function sdpHeaders(extra: Record<string, string> = {}) {
  const apiKey = process.env.SDP_API_KEY;
  if (!apiKey) throw new Error("SDP_API_KEY is required");
  return {
    Authorization: \`Bearer \${apiKey}\`,
    "Content-Type": "application/json",
    ...extra,
  };
}

async function sdpFetch(path: string, init?: RequestInit) {
  const response = await fetch(\`\${SDP_API_URL}\${path}\`, init);
  // An error body is not always JSON (a gateway 502, an empty 503), so parse
  // defensively and keep the status in the thrown message either way.
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      result?.error?.message ?? \`SDP request failed: \${path} (\${response.status})\`
    );
  }
  return result.data;
}

/**
 * Step 1 — build. SDP returns an UNSIGNED transaction for your customer's
 * wallet: it is the fee payer and the only required signer. Hand the base64
 * \`transaction\` to the wallet in the browser, e.g. with wallet-adapter:
 *
 *   const tx = VersionedTransaction.deserialize(Buffer.from(transaction, "base64"));
 *   const signed = await wallet.signTransaction(tx);
 *   const signedTransaction = Buffer.from(signed.serialize()).toString("base64");
 *
 * A built transaction expires with its blockhash (about a minute); build a
 * fresh one if the customer walks away before signing.
 */
export async function buildEarnDepositTransaction({
  ownerAddress,
  amount,
  minSharesOut,
}: {
  /** The customer's Solana wallet address. */
  ownerAddress: string;
  /** Deposit amount in the vault token's units, as a decimal string. */
  amount: string;
  /** Minimum acceptable shares, derived from your quote and slippage tolerance. */
  minSharesOut: string;
}) {
  const data = await sdpFetch("/v1/earn/external-wallet/deposit-transactions", {
    method: "POST",
    headers: sdpHeaders(),
    body: JSON.stringify({
      strategyId: ${JSON.stringify(strategy.id)},
      ownerAddress,
      amount,
      minSharesOut,
    }),
  });
  // { transactionId, transaction, lastValidBlockHeight, ... }
  return data.transaction;
}

/**
 * Step 2 — submit the signed bytes. SDP verifies they are exactly the
 * transaction it built and that your customer's signature is genuine, records
 * the deposit, then broadcasts it. Reuse the SAME idempotency key when
 * retrying this call: a retry returns the original deposit with
 * \`replayed: true\` instead of moving money twice.
 */
export async function submitEarnDeposit({
  transactionId,
  signedTransaction,
  idempotencyKey,
}: {
  transactionId: string;
  /** Base64 of the signed transaction bytes from the customer's wallet. */
  signedTransaction: string;
  idempotencyKey: string;
}) {
  const data = await sdpFetch("/v1/earn/external-wallet/deposits", {
    method: "POST",
    headers: sdpHeaders({ "Idempotency-Key": idempotencyKey }),
    body: JSON.stringify({ transactionId, signedTransaction }),
  });
  // { movementId, positionId, status, signature, replayed, ... }
  return data.deposit;
}

/**
 * Step 3 — poll the movement to a terminal state. \`confirmed\` is optimistic;
 * only \`finalized\` and \`failed\` are terminal, and SDP settles every movement
 * within about ninety seconds.
 */
export async function getEarnMovement(movementId: string) {
  const data = await sdpFetch(
    \`/v1/earn/external-wallet/movements/\${encodeURIComponent(movementId)}\`,
    { headers: sdpHeaders() }
  );
  // { movementId, direction, status, amount, denomination, signature, ... }
  return data.movement;
}

/**
 * Balance + total earned, grouped by deposit token. \`earned\` is stated only
 * when exact — otherwise it is ABSENT with \`earnedUnavailableReason\`, never
 * zero. Render an em dash or a spinner for an absent figure, never $0.
 */
export async function getEarnEarnings(ownerAddress: string) {
  const data = await sdpFetch(
    \`/v1/earn/external-wallet/earnings/\${encodeURIComponent(ownerAddress)}\`,
    { headers: sdpHeaders() }
  );
  // { ownerAddress, totalsByToken: [{ currentValue?, totalDeposited, earned?, ... }] }
  return data.earnings;
}

/** Activity feed: the customer's deposits and withdrawals, newest first. */
export async function listEarnActivity(ownerAddress: string, cursor?: string) {
  const query = new URLSearchParams({ ownerAddress });
  if (cursor) query.set("before", cursor);
  // { movements, hasMore, nextCursor }
  return sdpFetch(\`/v1/earn/external-wallet/movements?\${query}\`, { headers: sdpHeaders() });
}

/**
 * The customer's live positions. A withdrawal names a POSITION and a share
 * amount: read \`id\` and \`withdrawableShares\` here to drive the withdraw flow.
 */
export async function listEarnPositions(ownerAddress: string) {
  const data = await sdpFetch(
    \`/v1/earn/external-wallet/positions/\${encodeURIComponent(ownerAddress)}\`,
    { headers: sdpHeaders() }
  );
  // { positions: [{ id, shares?, withdrawableShares?, tokenValue?, ... }] }
  return data.positions;
}

/**
 * Withdraw, step 1 — build the unsigned exit for the customer's wallet to
 * sign. Exits keep working even when deposits are paused: money out is never
 * gated by money-in rules.
 */
export async function buildEarnWithdrawalTransaction({
  positionId,
  shares,
}: {
  /** The position \`id\` from listEarnPositions. */
  positionId: string;
  /** Shares to redeem, at most \`withdrawableShares\`, as a decimal string. */
  shares: string;
}) {
  const data = await sdpFetch("/v1/earn/external-wallet/withdrawal-transactions", {
    method: "POST",
    headers: sdpHeaders(),
    body: JSON.stringify({ positionId, shares }),
  });
  return data.transaction;
}

/** Withdraw, step 2 — submit the signed exit; same idempotency contract as the deposit. */
export async function submitEarnWithdrawal({
  transactionId,
  signedTransaction,
  idempotencyKey,
}: {
  transactionId: string;
  signedTransaction: string;
  idempotencyKey: string;
}) {
  const data = await sdpFetch("/v1/earn/external-wallet/withdrawals", {
    method: "POST",
    headers: sdpHeaders({ "Idempotency-Key": idempotencyKey }),
    body: JSON.stringify({ transactionId, signedTransaction }),
  });
  return data.withdrawal;
}`;
}
