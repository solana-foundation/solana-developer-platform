import { DEFAULT_SDP_API_URL, type EarnStrategy } from "@sdp/types";

/**
 * The complete B2B2C loop, exactly as shipped (PRO-1722 + PRO-1772): the
 * partner's backend BUILDS an unsigned transaction for the customer's own
 * wallet, the wallet signs it in the browser, the backend SUBMITS the signed
 * bytes, and SDP verifies the signature, records the movement, then broadcasts.
 * The reads close the loop: poll the movement to a terminal state, show
 * balance + earned, list activity, and withdraw the same way money came in.
 *
 * Server-only examples by construction: the API key comes from process.env
 * and the browser/mobile app is expected to call this partner-owned backend.
 * The customer's key never leaves their wallet, and the partner's key never
 * reaches the browser. The treasury route (`/vault-deposits` +
 * `custodyWalletId`) must not appear here — a B2B2C partner cannot name a
 * custody wallet.
 *
 * The guide renders one section per concern so a partner engineer can read it
 * top to bottom. The sections concatenate into one module. Wallet products
 * supply a base64-in, base64-out signer for their customer wallet and, when
 * sponsoring fees, their server-side sponsor wallet.
 *
 * The public docs guide (apps/sdp-docs/content/docs/guides/embedded-yield.mdx)
 * documents this same flow. Update both together.
 */
export interface EarnIntegrationSections {
  /** Shared client setup: base URL, auth headers, response envelope. */
  client: string;
  /** Money in: build → customer signs → submit → poll to terminal. */
  deposit: string;
  /** Reads: balance + earned, activity feed, live positions. */
  portfolio: string;
  /** Money out: build the exit → customer signs → submit. */
  withdraw: string;
}

export function buildEarnIntegrationSections(
  strategy: Pick<
    EarnStrategy,
    "id" | "provider" | "depositMints" | "hostCluster" | "depositSlippage" | "withdrawalSlippage"
  >,
  apiBaseUrl?: string
): EarnIntegrationSections {
  const directDepositMint = strategy.depositMints[0];
  if (!directDepositMint) throw new Error(`Earn strategy ${strategy.id} has no deposit mint`);
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
    ? `  const quote = await sdpFetch("/v1/earn/vault-deposit-previews", {
    method: "POST",
    headers: sdpHeaders(),
    body: JSON.stringify({ strategyId: EMBEDDED_YIELD_STRATEGY.id, amount }),
  });
  if (quote.blockingIssues.length > 0) {
    throw new Error(quote.blockingIssues.map((issue: { message: string }) => issue.message).join("; "));
  }
  const minSharesOut = floorForTolerance(quote.sharesOut, quote.shareDecimals, slippageBps);`
    : "  const minSharesOut = undefined; // This provider does not require a quote-derived floor.";
  const withdrawalFloor = requiresWithdrawalFloor
    ? `  const quote = await sdpFetch("/v1/earn/external-wallet/withdrawal-previews", {
    method: "POST",
    headers: sdpHeaders(),
    body: JSON.stringify({ positionId, shares }),
  });
  if (quote.blockingIssues.length > 0) {
    throw new Error(quote.blockingIssues.map((issue: { message: string }) => issue.message).join("; "));
  }
  const minAmountOut = floorForTolerance(quote.assetsOut, quote.assetDecimals, slippageBps);`
    : "  const minAmountOut = undefined; // This provider does not require a quote-derived floor.";
  const client = `const SDP_API_URL = ${JSON.stringify(apiBaseUrl ?? DEFAULT_SDP_API_URL)};
const EMBEDDED_YIELD_STRATEGY = ${JSON.stringify(
    {
      id: strategy.id,
      provider: strategy.provider,
      directDepositMint,
      hostCluster: strategy.hostCluster,
    },
    null,
    2
  )} as const;

// Create an API key scoped to this project with earn:read + earn:write.
// Keep it on your server. The customer's wallet signs in the browser or app.

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

/** Discover strategy ids and accepted direct-deposit mints from the API. */
export async function listEarnStrategies() {
  return sdpFetch("/v1/earn/strategies?page=1&pageSize=100", {
    headers: sdpHeaders(),
  });
}

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
}

export type EarnTransactionSigner = (transactionBase64: string) => Promise<string>;

/** Collect every signature required by the exact transaction SDP built. */
export async function signEarnTransaction(
  built: { transaction: string; feePayer?: string },
  customerSigner: EarnTransactionSigner,
  sponsorSigner?: EarnTransactionSigner
) {
  const customerSigned = await customerSigner(built.transaction);
  if (!built.feePayer) return customerSigned;
  if (!sponsorSigner) throw new Error("Sponsor signature is required for this transaction");
  return sponsorSigner(customerSigned);
}`;

  const deposit = `/**
 * Build an unsigned direct deposit. Omit feePayer for customer-paid fees.
 * Pass your sponsor address to pay fees and first-deposit account rent.
 * signEarnTransaction collects both signatures when the built transaction
 * echoes a feePayer.
 */
export async function buildEarnDepositTransaction({
  ownerAddress,
  amount,
  feePayer,
${depositSlippageInput}}: {
  ownerAddress: string;
  amount: string;
  feePayer?: string;
${depositSlippageType}}) {
${depositFloor}
  const data = await sdpFetch("/v1/earn/external-wallet/deposit-transactions", {
    method: "POST",
    headers: sdpHeaders(),
    body: JSON.stringify({
      strategyId: EMBEDDED_YIELD_STRATEGY.id,
      ownerAddress,
      amount,
      sourceTokenMint: EMBEDDED_YIELD_STRATEGY.directDepositMint,
      ...(feePayer ? { feePayer } : {}),
      ...(minSharesOut ? { minSharesOut } : {}),
    }),
  });
  return data.transaction;
}

/**
 * Submit only after every required wallet has signed. Reuse the same
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
 * Poll the movement to a terminal state. \`confirmed\` is optimistic;
 * only \`finalized\` and \`failed\` are terminal. Each detail read performs a
 * bounded live chain check; scheduled reconciliation remains the recovery path.
 */
export async function getEarnMovement(movementId: string) {
  const data = await sdpFetch(
    \`/v1/earn/external-wallet/movements/\${encodeURIComponent(movementId)}\`,
    { headers: sdpHeaders() }
  );
  // { movementId, direction, status, amount, denomination, signature, ... }
  return data.movement;
}

export async function waitForEarnMovement(
  movementId: string,
  { signal, intervalMs = 2_000 }: { signal?: AbortSignal; intervalMs?: number } = {}
) {
  while (true) {
    signal?.throwIfAborted();
    const movement = await getEarnMovement(movementId);
    if (movement.status === "finalized" || movement.status === "failed") return movement;
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
 * Balance + total earned, grouped by deposit token. \`earned\` is stated only
 * when exact — otherwise it is ABSENT with \`earnedUnavailableReason\`, never
 * zero. Render an em dash or a spinner for an absent figure, never $0.
 */
export async function getEarnEarnings(ownerAddress: string) {
  const data = await sdpFetch(
    \`/v1/earn/external-wallet/earnings?\${new URLSearchParams({ ownerAddress })}\`,
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
 * The customer's live positions, paged to completion — a silently short list
 * hides withdrawable money. A withdrawal names a POSITION and a share amount:
 * read \`id\` and \`withdrawableShares\` here to drive the withdraw flow.
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
 * Build an unsigned exit. Omit feePayer for customer-paid fees, or pass the
 * same sponsor address pattern used for deposits. Exits remain available when
 * deposits are paused.
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

  return { client, deposit, portfolio, withdraw };
}

/** The sections joined into the one server module they document. */
export function buildEarnServerIntegration(
  strategy: Pick<
    EarnStrategy,
    "id" | "provider" | "depositMints" | "hostCluster" | "depositSlippage" | "withdrawalSlippage"
  >,
  apiBaseUrl?: string
): string {
  const sections = buildEarnIntegrationSections(strategy, apiBaseUrl);
  return [sections.client, sections.deposit, sections.portfolio, sections.withdraw].join("\n\n");
}
