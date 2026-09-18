import { DEFAULT_SDP_API_URL, type EarnStrategy } from "@sdp/types";

/**
 * The authenticated Embedded Yield loop, exactly as shipped (PRO-1722 +
 * PRO-1772): the partner's backend BUILDS an unsigned transaction for the
 * customer's own wallet, the wallet signs it, the backend SUBMITS the signed
 * bytes, and SDP verifies the signature, records the movement, then
 * broadcasts. The reads close the loop: poll the movement to a terminal
 * state, show balance and earned, list activity, and withdraw the same way
 * money came in.
 *
 * Copy-and-go by construction: the module needs one strategy id and one API
 * key. The API key comes from process.env and never reaches a browser; the
 * customer's key never leaves their wallet. The treasury route
 * (`/vault-deposits` + `custodyWalletId`) must not appear here, because a
 * partner cannot name a custody wallet.
 *
 * The sections concatenate into one server module. `@solana/kit` is the only
 * Solana SDK referenced, and only by the optional sponsor signer.
 *
 * The public docs guide (apps/sdp-docs/content/docs/guides/embedded-yield.mdx)
 * documents this same authenticated flow plus the keyless catalogue and
 * unsigned-build tier. Keep the shared contract aligned in both.
 */
export interface EarnIntegrationSections {
  /** Shared client setup: base URL, auth headers, response envelope, signers. */
  client: string;
  /** Money in: build, customer signs, submit, poll to terminal. */
  deposit: string;
  /** Reads: balance and earned, activity feed, live positions. */
  portfolio: string;
  /** Money out: preview, build the exit, customer signs, submit. */
  withdraw: string;
  /** Asynchronous money out: request, observe solver outcome, or recover shares. */
  asyncWithdraw: string;
}

export type EarnIntegrationStrategy = Pick<
  EarnStrategy,
  "id" | "depositSlippage" | "withdrawalSlippage"
>;

export function buildEarnIntegrationSections(
  strategy: EarnIntegrationStrategy,
  apiBaseUrl?: string
): EarnIntegrationSections {
  const requiresDepositFloor = strategy.depositSlippage?.quoteRequired === true;
  const requiresWithdrawalFloor = strategy.withdrawalSlippage?.quoteRequired === true;
  const depositSlippageInput = requiresDepositFloor
    ? `  slippageBps = ${strategy.depositSlippage?.defaultToleranceBps ?? 10},\n`
    : "";
  const withdrawalSlippageInput = requiresWithdrawalFloor
    ? `  slippageBps = ${strategy.withdrawalSlippage?.defaultToleranceBps ?? 10},\n`
    : "";
  const depositSlippageType = requiresDepositFloor
    ? "  /** Customer-selected slippage tolerance in basis points. */\n  slippageBps?: number;\n"
    : "";
  const withdrawalSlippageType = requiresWithdrawalFloor
    ? "  /** Customer-selected slippage tolerance in basis points. */\n  slippageBps?: number;\n"
    : "";
  const depositFloor = requiresDepositFloor
    ? `  // This strategy requires a quote-derived floor: preview, then take the
  // customer's tolerance off the live figure.
  const quote = await previewEarnDeposit(amount);
  if (quote.blockingIssues.length > 0) {
    throw new Error(quote.blockingIssues.map((issue: { message: string }) => issue.message).join("; "));
  }
  const minSharesOut = floorForTolerance(quote.sharesOut, quote.shareDecimals, slippageBps);`
    : "  // This strategy declares no deposit floor (depositSlippage is null): the\n  // deposit takes the live rate. Preview with previewEarnDeposit to show it.\n  const minSharesOut = undefined;";
  const withdrawalFloor = requiresWithdrawalFloor
    ? `  // This strategy requires a quote-derived floor: preview, then take the
  // customer's tolerance off the live figure.
  const quote = await previewEarnWithdrawal(positionId, shares);
  if (quote.blockingIssues.length > 0) {
    throw new Error(quote.blockingIssues.map((issue: { message: string }) => issue.message).join("; "));
  }
  const minAmountOut = floorForTolerance(quote.assetsOut, quote.assetDecimals, slippageBps);`
    : "  // This strategy enforces no exit floor on chain (withdrawalSlippage is\n  // null), so minAmountOut is not accepted. Preview with previewEarnWithdrawal\n  // to show the expected payout.\n  const minAmountOut = undefined;";
  const floorHelper =
    requiresDepositFloor || requiresWithdrawalFloor
      ? `

/** Exact decimal floor without a JavaScript number round-trip. */
function floorForTolerance(quote: string, decimals: number, toleranceBps: number) {
  if (!Number.isInteger(toleranceBps) || toleranceBps < 1 || toleranceBps > 1_000) {
    throw new Error("slippage tolerance must be 1-1000 basis points");
  }
  const [whole, fraction = ""] = quote.split(".");
  if (!/^\\d+$/.test(whole ?? "") || !/^\\d*$/.test(fraction) || fraction.length > decimals) {
    throw new Error("provider quote is not a valid decimal at the reported mint scale");
  }
  const atoms = BigInt((whole ?? "0") + fraction.padEnd(decimals, "0"));
  if (atoms === 0n) throw new Error("provider quote returned zero output");
  const floored = (atoms * BigInt(10_000 - toleranceBps)) / 10_000n || 1n;
  const digits = floored.toString().padStart(decimals + 1, "0");
  if (decimals === 0) return digits;
  const wholeResult = digits.slice(0, -decimals);
  const fractionResult = digits.slice(-decimals).replace(/0+$/, "");
  return fractionResult ? \`\${wholeResult}.\${fractionResult}\` : wholeResult;
}`
      : "";

  const client = `const SDP_API_URL = ${JSON.stringify(apiBaseUrl ?? DEFAULT_SDP_API_URL)};
const STRATEGY_ID = ${JSON.stringify(strategy.id)};

// Create a Developer API key for this project in the dashboard (it includes
// earn:read and earn:write) and keep it on your server. The customer's wallet
// signs in your browser or mobile app; it never sees this key.

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
    const code = result?.error?.code ? \` \${result.error.code}\` : "";
    const message = result?.error?.message ?? "Request failed";
    throw new Error(\`SDP \${response.status}\${code}: \${message}\`);
  }
  return result.data;
}

/** The catalogue: every strategy id and its live APY. */
export async function listEarnStrategies() {
  return sdpFetch("/v1/earn/strategies?page=1&pageSize=100", {
    headers: sdpHeaders(),
  });
}

/** What a deposit would mint right now. Read-only; nothing is built. */
export async function previewEarnDeposit(amount: string) {
  // { sharesOut, shareDecimals, blockingIssues }
  return sdpFetch("/v1/earn/vault-deposit-previews", {
    method: "POST",
    headers: sdpHeaders(),
    body: JSON.stringify({ strategyId: STRATEGY_ID, amount }),
  });
}

/** What redeeming these shares would pay right now. Read-only; nothing is built. */
export async function previewEarnWithdrawal(positionId: string, shares: string) {
  // { assetsOut, assetDecimals, blockingIssues }
  return sdpFetch("/v1/earn/external-wallet/withdrawal-previews", {
    method: "POST",
    headers: sdpHeaders(),
    body: JSON.stringify({ positionId, shares }),
  });
}${floorHelper}

export type EarnTransactionSigner = (transactionBase64: string) => Promise<string>;

/** Collect every signature the built transaction requires. */
export async function signEarnTransaction(
  built: { transaction: string; feePayer?: string },
  customerSigner: EarnTransactionSigner,
  sponsorSigner?: EarnTransactionSigner
) {
  const customerSigned = await customerSigner(built.transaction);
  if (!built.feePayer) return customerSigned;
  if (!sponsorSigner) throw new Error("Sponsor signature is required for this transaction");
  return sponsorSigner(customerSigned);
}

/**
 * A server-side signer for a wallet you control, such as your fee sponsor.
 * Base64 in, base64 out, the same shape your customer wallet integration
 * returns. Requires @solana/kit. Never use it for a customer's key.
 */
export async function createSponsorSigner(secretKey: Uint8Array): Promise<EarnTransactionSigner> {
  const kit = await import("@solana/kit");
  const keyPair = await kit.createKeyPairFromBytes(secretKey);
  return async (transactionBase64) => {
    const transaction = kit
      .getTransactionDecoder()
      .decode(kit.getBase64Encoder().encode(transactionBase64));
    const signed = await kit.partiallySignTransaction([keyPair], transaction);
    return kit.getBase64EncodedWireTransaction(signed);
  };
}`;

  const deposit = `/**
 * Build an unsigned deposit for the customer's wallet. Omit feePayer and the
 * customer pays the network fee and any first-deposit account rent; pass your
 * sponsor address to pay both, then co-sign with createSponsorSigner.
 */
export async function buildEarnDepositTransaction({
  ownerAddress,
  amount,
  feePayer,
${depositSlippageInput}}: {
  ownerAddress: string;
  /** Decimal string in the strategy's deposit token. */
  amount: string;
  feePayer?: string;
${depositSlippageType}}) {
${depositFloor}
  const data = await sdpFetch("/v1/earn/external-wallet/deposit-transactions", {
    method: "POST",
    headers: sdpHeaders(),
    body: JSON.stringify({
      strategyId: STRATEGY_ID,
      ownerAddress,
      amount,
      ...(feePayer ? { feePayer } : {}),
      ...(minSharesOut ? { minSharesOut } : {}),
    }),
  });
  // { transactionId, transaction, lastValidBlockHeight, feePayer?, ... }
  return data.transaction;
}

/**
 * Submit once every required wallet has signed. A build expires with its
 * blockhash (about a minute): an expired build is refused with 409
 * TRANSACTION_EXPIRED and nothing is recorded, so build again. Reuse the same
 * idempotency key when retrying this exact submission.
 */
export async function submitEarnDeposit({
  transactionId,
  signedTransaction,
  idempotencyKey,
}: {
  transactionId: string;
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
 * One movement. Statuses: requested (recorded, not yet seen on the network),
 * submitted, confirmed, finalized, failed. Treat confirmed as Done in the UI;
 * SDP continues tracking finalized or failed as the durable ledger outcome.
 */
export async function getEarnMovement(movementId: string) {
  const data = await sdpFetch(
    \`/v1/earn/external-wallet/movements/\${encodeURIComponent(movementId)}\`,
    { headers: sdpHeaders() }
  );
  // { movementId, direction, status, tokenAmount, tokenMint, signature, failureReason, ... }
  return data.movement;
}

export async function waitForEarnMovement(
  movementId: string,
  { signal, intervalMs = 1_000 }: { signal?: AbortSignal; intervalMs?: number } = {}
) {
  while (true) {
    signal?.throwIfAborted();
    const movement = await getEarnMovement(movementId);
    if (
      movement.status === "confirmed" ||
      movement.status === "finalized" ||
      movement.status === "failed"
    ) return movement;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, intervalMs);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("Polling aborted"));
      }, { once: true });
    });
  }
}`;

  const portfolio = `/**
 * Balance and earned per deposit token. A customer with no history answers
 * empty totals, not an error. \`earned\` is current value plus withdrawn minus
 * deposited, and is ABSENT with \`earnedUnavailableReason\` while a movement
 * is pending or a payout could not be valued: render a dash, never $0.
 */
export async function getEarnEarnings(ownerAddress: string) {
  const data = await sdpFetch(
    \`/v1/earn/external-wallet/earnings?\${new URLSearchParams({ ownerAddress })}\`,
    { headers: sdpHeaders() }
  );
  // { ownerAddress, totalsByToken: [{ tokenMint, currentValue?, totalDeposited, totalWithdrawn, earned?, ... }] }
  return data.earnings;
}

/**
 * Activity feed, newest first. Render \`tokenAmount\` in \`tokenMint\` units for
 * both directions; \`amount\`/\`denomination\` is the on-chain quantity, which is
 * shares on a withdrawal. A withdrawal's tokenAmount is null until it finalizes.
 */
export async function listEarnActivity(ownerAddress: string, cursor?: string) {
  const query = new URLSearchParams({ ownerAddress });
  if (cursor) query.set("before", cursor);
  // { movements, hasMore, nextCursor }
  return sdpFetch(\`/v1/earn/external-wallet/movements?\${query}\`, { headers: sdpHeaders() });
}

/**
 * Live positions, paged to completion: a silently short list hides
 * withdrawable money. A withdrawal names a POSITION and a share amount, so
 * read \`id\` and \`withdrawableShares\` here. A fully exited position closes and
 * drops out of this list. If the live read fails, \`shares\`,
 * \`withdrawableShares\` and \`tokenValue\` are absent, never zero: show an
 * unavailable state and disable withdrawal until a fresh read succeeds.
 */
export async function listEarnPositions(ownerAddress: string) {
  const positions = [];
  let cursor;
  do {
    const query = new URLSearchParams({ ownerAddress });
    if (cursor) query.set("before", cursor);
    const data = await sdpFetch(
      \`/v1/earn/external-wallet/positions?\${query}\`,
      { headers: sdpHeaders() }
    );
    // { positions: [{ id, shares?, withdrawableShares?, tokenValue?, ... }], hasMore, nextCursor }
    positions.push(...data.positions);
    if (!data.hasMore) return positions;
    if (!data.nextCursor || data.nextCursor === cursor) {
      throw new Error("SDP positions cursor did not advance");
    }
    cursor = data.nextCursor;
  } while (true);
}`;

  const withdraw = `/**
 * Build an unsigned exit. Same fee rules as the deposit: omit feePayer and the
 * customer pays, or pass your sponsor address and co-sign. Exits keep working
 * when deposits are paused.
 */
export async function buildEarnWithdrawalTransaction({
  positionId,
  shares,
  feePayer,
${withdrawalSlippageInput}}: {
  positionId: string;
  shares: string;
  feePayer?: string;
${withdrawalSlippageType}}) {
${withdrawalFloor}
  const data = await sdpFetch("/v1/earn/external-wallet/withdrawal-transactions", {
    method: "POST",
    headers: sdpHeaders(),
    body: JSON.stringify({
      positionId,
      shares,
      ...(feePayer ? { feePayer } : {}),
      ...(minAmountOut ? { minAmountOut } : {}),
    }),
  });
  return data.transaction;
}

/** Submit the signed exit; same idempotency and expiry contract as the deposit. */
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

  const asyncWithdraw = `/**
 * Read instant and queued routes independently. Never auto-select: an instant
 * redemption pays now, while a queued request escrows shares for the provider.
 */
export async function getEarnWithdrawalOptions(positionId: string) {
  return sdpFetch("/v1/earn/external-wallet/withdrawal-options", {
    method: "POST",
    headers: sdpHeaders(),
    body: JSON.stringify({ positionId }),
  });
}

/** Preview exact queue terms from live chain state before building. */
export async function previewEarnQueuedWithdrawal({
  positionId,
  shares,
  discountBps,
  deadlineSeconds,
}: {
  positionId: string;
  shares: string;
  discountBps: number;
  deadlineSeconds: number;
}) {
  return sdpFetch("/v1/earn/external-wallet/queued-withdrawal-previews", {
    method: "POST",
    headers: sdpHeaders(),
    body: JSON.stringify({ positionId, shares, discountBps, deadlineSeconds }),
  });
}

/**
 * Build an unsigned queue request. Landing this transaction escrows shares; it
 * does NOT pay assets. The provider's solve authority may fulfil after maturity.
 */
export async function buildEarnQueuedWithdrawalRequest({
  positionId,
  shares,
  discountBps,
  deadlineSeconds,
  feePayer,
}: {
  positionId: string;
  shares: string;
  discountBps: number;
  deadlineSeconds: number;
  feePayer?: string;
}) {
  const data = await sdpFetch("/v1/earn/external-wallet/withdrawal-request-transactions", {
    method: "POST",
    headers: sdpHeaders(),
    body: JSON.stringify({
      positionId,
      shares,
      discountBps,
      deadlineSeconds,
      ...(feePayer ? { feePayer } : {}),
    }),
  });
  // Includes requestAddress and the expected quote/timestamps.
  return data.transaction;
}

export async function submitEarnQueuedWithdrawalRequest(input: {
  transactionId: string;
  signedTransaction: string;
  idempotencyKey: string;
}) {
  const data = await sdpFetch("/v1/earn/external-wallet/withdrawal-requests", {
    method: "POST",
    headers: sdpHeaders({ "Idempotency-Key": input.idempotencyKey }),
    body: JSON.stringify({
      transactionId: input.transactionId,
      signedTransaction: input.signedTransaction,
    }),
  });
  return data.withdrawalRequest;
}

/**
 * Poll this durable object, not the request-creation transaction. Terminal
 * states are fulfilled, cancelled, and failed. closedOrUnknown is retryable:
 * SDP is still indexing the close event to distinguish payout from recovery.
 */
export async function getEarnQueuedWithdrawalRequest(withdrawalRequestId: string) {
  const data = await sdpFetch(
    \`/v1/earn/external-wallet/withdrawal-requests/\${encodeURIComponent(withdrawalRequestId)}\`,
    { headers: sdpHeaders() }
  );
  return data.withdrawalRequest;
}

/**
 * Once status is expiredCancelable, build the holder's recovery transaction.
 * Cancelling before the deadline is rejected by the provider's queue program.
 */
export async function buildEarnQueuedWithdrawalCancellation({
  withdrawalRequestId,
  feePayer,
}: {
  withdrawalRequestId: string;
  feePayer?: string;
}) {
  const data = await sdpFetch(
    "/v1/earn/external-wallet/withdrawal-request-cancel-transactions",
    {
      method: "POST",
      headers: sdpHeaders(),
      body: JSON.stringify({
        withdrawalRequestId,
        ...(feePayer ? { feePayer } : {}),
      }),
    }
  );
  return data.transaction;
}

export async function submitEarnQueuedWithdrawalCancellation(input: {
  transactionId: string;
  signedTransaction: string;
  idempotencyKey: string;
}) {
  const data = await sdpFetch(
    "/v1/earn/external-wallet/withdrawal-request-cancellations",
    {
      method: "POST",
      headers: sdpHeaders({ "Idempotency-Key": input.idempotencyKey }),
      body: JSON.stringify({
        transactionId: input.transactionId,
        signedTransaction: input.signedTransaction,
      }),
    }
  );
  return data.withdrawalRequest;
}`;

  return { client, deposit, portfolio, withdraw, asyncWithdraw };
}

/** The sections joined into the one server module they document. */
export function buildEarnServerIntegration(
  strategy: EarnIntegrationStrategy,
  apiBaseUrl?: string
): string {
  const sections = buildEarnIntegrationSections(strategy, apiBaseUrl);
  return [
    sections.client,
    sections.deposit,
    sections.portfolio,
    sections.withdraw,
    sections.asyncWithdraw,
  ].join("\n\n");
}
