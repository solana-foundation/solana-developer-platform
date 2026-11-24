/** The operation fields this example reads; the API returns more. */
export interface Operation {
  id: string;
  status: string;
  actionId: string;
  version: number;
  terms: unknown;
  nextAction: { type: string; transaction?: string } | null;
}

/** A `POST /v1/earn/deposit` body. */
export interface Deposit {
  strategyId: string;
  source: { ownerAddress: string };
  amount: { mint: string; value: string };
  slippageBps?: number;
}

export interface DepositOptions {
  apiUrl: string;
  /** Your SDP API key. Keep it on your server. */
  apiKey: string;
  deposit: Deposit;
  /**
   * Generate once per deposit and save it before calling. Calling again with
   * the same key replays the same requests instead of depositing twice.
   */
  idempotencyKey: string;
  /** Show `operation.terms`, then return `transaction` signed by the owner, base64. */
  sign: (transaction: string, operation: Operation) => Promise<string>;
  fetch?: typeof fetch;
  pollIntervalMs?: number;
  maxPolls?: number;
}

const FINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

/** Prepares, signs, submits and polls one Earn deposit, returning the last operation read. */
export async function deposit({
  apiUrl,
  apiKey,
  deposit: body,
  idempotencyKey,
  sign,
  fetch: send = fetch,
  pollIntervalMs = 2_000,
  maxPolls = 60,
}: DepositOptions): Promise<Operation> {
  async function call(path: string, write?: { body: object; key: string }): Promise<Operation> {
    const response = await send(new URL(path, apiUrl), {
      method: write ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(write && { "Content-Type": "application/json", "Idempotency-Key": write.key }),
      },
      body: write && JSON.stringify(write.body),
    });
    if (!response.ok)
      throw new Error(`SDP ${response.status} on ${path}: ${await response.text()}`);
    return ((await response.json()) as { data: { operation: Operation } }).data.operation;
  }

  let operation = await call("/v1/earn/deposit", { body, key: `${idempotencyKey}:prepare` });
  // A replayed preparation that was already submitted skips straight to polling.
  const next = operation.nextAction;
  if (next?.type === "sign_transaction" && next.transaction !== undefined) {
    const { id, actionId, version } = operation;
    const signedTransaction = await sign(next.transaction, operation);
    operation = await call(`/v1/operations/${encodeURIComponent(id)}/submit`, {
      body: { actionId, version, signedTransaction },
      key: `${idempotencyKey}:submit`,
    });
  }
  for (let poll = 0; poll < maxPolls && !FINAL_STATUSES.has(operation.status); poll += 1) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    operation = await call(`/v1/operations/${encodeURIComponent(operation.id)}`);
  }
  return operation;
}
