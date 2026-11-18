import type { EarnStrategy } from "@sdp/types/earn";
import { DEFAULT_SDP_API_URL } from "@sdp/types/site";

/** The same server-side strategy and operation contract serves both Earn products. */
export interface EarnIntegrationSections {
  client: string;
  deposit: string;
  portfolio: string;
  withdraw: string;
  asyncWithdraw: string;
}

/** Strategy identity is the only integration-specific value embedded in the sample. */
export type EarnIntegrationStrategy = Pick<
  EarnStrategy,
  "id" | "depositSlippage" | "withdrawalSlippage"
>;

/** Copyable code keeps credentials server-side and leaves signing with the owner. */
export function buildEarnIntegrationSections(
  strategy: EarnIntegrationStrategy,
  apiBaseUrl = DEFAULT_SDP_API_URL
): EarnIntegrationSections {
  const client = `const SDP_API_URL = ${JSON.stringify(apiBaseUrl)};
const STRATEGY_ID = ${JSON.stringify(strategy.id)};

// Run this module on your server. The API key never reaches a customer browser.
// Store each idempotency key before sending, and reuse it for uncertain retries.
async function sdp(path: string, init: RequestInit = {}) {
  const apiKey = process.env.SDP_API_KEY;
  if (!apiKey) throw new Error("SDP_API_KEY is required");
  const response = await fetch(\`\${SDP_API_URL}\${path}\`, {
    ...init,
    headers: {
      Authorization: \`Bearer \${apiKey}\`,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message ?? \`SDP \${response.status}\`);
  if (!body?.data) throw new Error("Invalid SDP response");
  return body.data;
}

function post(path: string, input: unknown, idempotencyKey: string) {
  return sdp(path, {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(input),
  });
}

export async function listEarnStrategies() {
  const strategies = [];
  const seen = new Set<string>();
  for (let page = 1; page <= 100; page += 1) {
    const data = await sdp(\`/v1/earn/discovery?page=\${page}&pageSize=100\`);
    for (const strategy of data.strategies) {
      if (!seen.has(strategy.id)) { seen.add(strategy.id); strategies.push(strategy); }
    }
    if (strategies.length >= data.total) return strategies;
    if (data.strategies.length < 100) throw new Error("Incomplete strategy catalogue");
  }
  throw new Error("Strategy pagination exceeded its safety limit");
}`;

  const deposit = `/** Prepare only. Show returned terms before asking the customer to sign. */
export async function prepareEarnDeposit(input: {
  ownerAddress: string;
  amount: { mint: string; value: string };
  idempotencyKey: string;
  slippageBps?: number;
  feePayer?: string;
}) {
  const { ownerAddress, amount, idempotencyKey, slippageBps, feePayer } = input;
  const { operation } = await post("/v1/earn/deposit", {
    strategyId: STRATEGY_ID,
    source: { ownerAddress },
    amount,
    ...(slippageBps === undefined ? {} : { slippageBps }),
    ...(feePayer ? { feePayer } : {}),
  }, idempotencyKey);
  return operation;
}

/** Submit only the reviewed action/version, using the exact returned message. */
export async function submitEarnOperation(input: {
  operationId: string;
  actionId: string;
  version: number;
  idempotencyKey: string;
  signedTransaction?: string;
}) {
  const { operationId, idempotencyKey, ...action } = input;
  return (await post(\`/v1/operations/\${encodeURIComponent(operationId)}/submit\`, action, idempotencyKey)).operation;
}

// Customer flow: prepare -> review operation.terms -> sign nextAction.transaction
// in the customer's wallet -> submitEarnOperation with that signed transaction.
// A separate fee payer must co-sign. Never alter the message before submitting.
// Custody wallets use source: { walletId } and submit without signed bytes.
// Submission returns 202 once durable work is accepted; signing and broadcast run asynchronously.
// A funding swap and deposit share one atomic transaction, or preparation refuses the route.
// If nextAction.type is approve_in_provider, show its instructions and keep polling.`;

  const portfolio = `export async function getEarnOperation(operationId: string) {
  return (await sdp(\`/v1/operations/\${encodeURIComponent(operationId)}\`)).operation;
}

async function collectEarnPages(path: string, collection: "positions" | "operations") {
  const rows = [];
  const seen = new Set<string>();
  let before: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const query = new URLSearchParams({ limit: "100" });
    if (before) query.set(collection === "operations" ? "cursor" : "before", before);
    const data = await sdp(\`\${path}\${path.includes("?") ? "&" : "?"}\${query}\`);
    rows.push(...data[collection]);
    if (!data.nextCursor) return rows;
    if (seen.has(data.nextCursor)) throw new Error("Pagination did not advance");
    seen.add(data.nextCursor);
    before = data.nextCursor;
  }
  throw new Error("Pagination exceeded its safety limit");
}

export function listEarnPositions(ownerAddress: string) {
  return collectEarnPages(\`/v1/earn/positions?sourceType=address&ownerAddress=\${encodeURIComponent(ownerAddress)}&discover=true\`, "positions");
}

export function listEarnActivity(ownerAddress: string) {
  return collectEarnPages(\`/v1/operations?ownerAddress=\${encodeURIComponent(ownerAddress)}\`, "operations");
}

// discover=true includes verified holdings in integrated strategies for this explicit owner.
// Check coverage and discovery.unavailableStrategyCount; this is not every protocol on Solana.
// Discovered acquisition dates and unknown cost basis are never inferred.
// Absent shares/value mean unavailable, never zero. Values retain token units.
// Poll active operations through approval, chain confirmation and provider settlement.
// Only completed means the expected shares or payout were actually delivered.`;

  const withdraw = `/** The position binds its owner, strategy and underlying provider vault. */
export async function prepareEarnWithdrawal(input: {
  positionId: string;
  amount: { kind: "all" } | { kind: "shares"; value: string }
    | { kind: "token" | "intermediate"; mint: string; value: string };
  idempotencyKey: string;
  slippageBps?: number;
  feePayer?: string;
}) {
  const { idempotencyKey, ...intent } = input;
  return (await post("/v1/earn/withdraw", intent, idempotencyKey)).operation;
}

// The same endpoint prepares direct, queued and provider-operated withdrawals.
// If nextAction.type is select_option, show terms.options and call
// refreshEarnOperation with the selected optionId to prepare its transaction.
// Review the returned terms, then sign/submit the current action as in the deposit flow.
// A submitted queue request escrows shares; it is not a completed payout.`;

  const asyncWithdraw = `/** Cancellation can itself return an action that needs a signature. */
export async function requestEarnCancellation(operationId: string, idempotencyKey: string) {
  return (await post(\`/v1/operations/\${encodeURIComponent(operationId)}/cancel\`, {}, idempotencyKey)).operation;
}

/** Prepare a selected route, or safely replace an action the API marks refreshable. */
export async function refreshEarnOperation(input: {
  operationId: string;
  actionId: string;
  version: number;
  optionId?: string;
  idempotencyKey: string;
}) {
  const { operationId, idempotencyKey, ...action } = input;
  return (await post(\`/v1/operations/\${encodeURIComponent(operationId)}/refresh\`, action, idempotencyKey)).operation;
}

// Resume the same operation after reload. Do not create a replacement because
// signing timed out or RPC history is missing. Cancellation acknowledgement
// does not prove signing or settlement stopped; keep watching the operation.
// Only nextAction.type === "refresh" explicitly offers a replacement action.
// A previously exposed wallet message needs authoritative reconciliation; expiry alone is not proof.
// Refresh changes the message: review new terms and obtain a new signature.`;
  return { client, deposit, portfolio, withdraw, asyncWithdraw };
}

/** One complete module, using the same source as each integration-guide section. */
export function buildEarnServerIntegration(
  strategy: EarnIntegrationStrategy,
  apiBaseUrl?: string
): string {
  return Object.values(buildEarnIntegrationSections(strategy, apiBaseUrl)).join("\n\n");
}
