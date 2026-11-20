/** Operation fields consumed by this example; the API returns additional fields. */
export interface Operation {
  id: string;
  actionId: string;
  version: number;
  status: string;
  terms: unknown;
  nextAction: { type: string; transaction?: string; instructions?: string } | null;
}

/** Persist each request before sending, including its exact signed bytes. */
export interface SavedRequest {
  path: string;
  key: string;
  body: unknown;
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object from SDP");
  }
  return value as Record<string, unknown>;
}

function parseOperation(value: unknown): Operation {
  const row = object(object(object(value).data).operation);
  const next = row.nextAction === null ? null : object(row.nextAction);
  if (
    typeof row.id !== "string" ||
    typeof row.actionId !== "string" ||
    typeof row.version !== "number" ||
    !Number.isInteger(row.version) ||
    row.version < 1 ||
    typeof row.status !== "string" ||
    (next !== null && typeof next.type !== "string")
  )
    throw new Error("Invalid SDP operation response");
  return {
    id: row.id,
    actionId: row.actionId,
    version: row.version,
    status: row.status,
    terms: row.terms,
    nextAction:
      next === null
        ? null
        : {
            type: String(next.type),
            ...(typeof next.transaction === "string" ? { transaction: next.transaction } : {}),
            ...(typeof next.instructions === "string" ? { instructions: next.instructions } : {}),
          },
  };
}

/**
 * Two writes and status reads, using native fetch. Your application supplies
 * wallet connection, review, signing and durable recovery storage.
 */
export async function depositAndTrack({
  apiUrl,
  apiKey,
  deposit,
  keys,
  save,
  review,
  signTransaction,
  observe,
  fetchRequest = fetch,
  wait = () => new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
}: {
  apiUrl: string;
  apiKey: string;
  deposit: {
    strategyId: string;
    source: { ownerAddress: string } | { walletId: string };
    amount: { mint: string; value: string };
    slippageBps?: number;
  };
  keys: { prepare: string; submit: string };
  save: (request: SavedRequest) => Promise<void>;
  review: (operation: Operation) => Promise<void>;
  signTransaction?: (unsignedBase64: string) => Promise<string>;
  observe: (operation: Operation) => void;
  fetchRequest?: typeof fetch;
  wait?: () => Promise<void>;
}): Promise<Operation> {
  async function request(path: string, input?: SavedRequest): Promise<Operation> {
    if (input) await save(input);
    const response = await fetchRequest(new URL(path, apiUrl), {
      method: input ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(input ? { "Content-Type": "application/json", "Idempotency-Key": input.key } : {}),
      },
      ...(input ? { body: JSON.stringify(input.body) } : {}),
    });
    if (!response.ok) {
      throw new Error(
        `SDP ${response.status} for ${path}. Preserve saved requests and recover the same operation before retrying.`
      );
    }
    return parseOperation(await response.json());
  }

  const path = "/v1/earn/deposit";
  const prepared = await request(path, { path, key: keys.prepare, body: deposit });
  await review(prepared);
  let signedTransaction: string | undefined;
  if (prepared.nextAction?.type === "sign_transaction") {
    if (!signTransaction || !prepared.nextAction.transaction) {
      throw new Error(`Provide the owner's signing callback for operation ${prepared.id}`);
    }
    signedTransaction = await signTransaction(prepared.nextAction.transaction);
    if (!signedTransaction) throw new Error("The wallet returned no signed transaction");
  } else if (prepared.nextAction?.type !== "submit") {
    throw new Error(
      `Review operation ${prepared.id}: ${prepared.nextAction?.type ?? prepared.status}`
    );
  }
  const submitPath = `/v1/operations/${encodeURIComponent(prepared.id)}/submit`;
  let operation = await request(submitPath, {
    path: submitPath,
    key: keys.submit,
    body: {
      actionId: prepared.actionId,
      version: prepared.version,
      ...(signedTransaction ? { signedTransaction } : {}),
    },
  });
  observe(operation);
  for (let read = 0; read < 60; read += 1) {
    if (["completed", "failed", "cancelled"].includes(operation.status)) return operation;
    await wait();
    operation = await request(`/v1/operations/${encodeURIComponent(operation.id)}`);
    observe(operation);
  }
  throw new Error(
    `Operation ${operation.id} is still pending. Keep polling it; do not prepare another deposit.`
  );
}
