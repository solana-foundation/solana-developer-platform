import { z } from "zod";
import type { WithdrawalIntent } from "@/types";
import { coreOperationSchema, type EarnOperation } from "./core-operation";

const pendingKey = "northstar:pending-operation:v1";
const actionSchema = z.object({
  operationId: z.string(),
  actionId: z.string(),
  version: z.number().int().positive(),
  idempotencyKey: z.string(),
});

async function withOperationLock<T>(work: () => Promise<T>): Promise<T> {
  if (!navigator.locks)
    throw new Error("This browser cannot safely save operation retries");
  return navigator.locks.request(pendingKey, work);
}

function assertNoPendingSubmission() {
  if (window.localStorage.getItem(pendingKey) !== null)
    throw new Error(
      "Recover the earlier pending transfer before starting another action"
    );
}

async function request(
  path: string,
  body: unknown,
  key?: string
): Promise<EarnOperation> {
  const response = await fetch(new URL(path, window.location.origin), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const result: unknown = await response.json().catch(() => null);
    const error = z
      .object({ error: z.object({ message: z.string() }) })
      .safeParse(result);
    throw new Error(
      error.success
        ? error.data.error.message
        : `Request failed (${response.status})`
    );
  }
  const result: unknown = await response.json();
  return z
    .object({ data: z.object({ operation: coreOperationSchema }) })
    .parse(result).data.operation;
}

/** Persist preparation identity before sending; a lost response retries the same operation. */
async function prepare(path: string, input: unknown): Promise<EarnOperation> {
  return withOperationLock(async () => {
    assertNoPendingSubmission();
    const storageKey = `northstar:prepare:${JSON.stringify([path, input])}`;
    const key = window.localStorage.getItem(storageKey) ?? crypto.randomUUID();
    window.localStorage.setItem(storageKey, key);
    const operation = await request(path, input, key);
    window.localStorage.removeItem(storageKey);
    return operation;
  });
}

export function prepareDepositOperation(
  amount: string
): Promise<EarnOperation> {
  return prepare("/api/deposits", { amount });
}

export function prepareWithdrawalOperation(
  input: WithdrawalIntent
): Promise<EarnOperation> {
  return prepare("/api/withdrawals", input);
}

async function submitSaved(
  action: z.infer<typeof actionSchema>
): Promise<EarnOperation> {
  const operation = await request(
    `/api/operations/${encodeURIComponent(action.operationId)}/submit`,
    {
      actionId: action.actionId,
      version: action.version,
      idempotencyKey: action.idempotencyKey,
    }
  );
  if (operation.id !== action.operationId)
    throw new Error("Operation response does not match the saved request");
  window.localStorage.removeItem(pendingKey);
  return operation;
}

/** Only this explicit user action can ask the demo wallet to sign. */
export async function submitPreparedOperation(
  operation: EarnOperation
): Promise<EarnOperation> {
  return withOperationLock(async () => {
    const saved = window.localStorage.getItem(pendingKey);
    const action =
      saved === null
        ? {
            operationId: operation.id,
            actionId: operation.actionId,
            version: operation.version,
            idempotencyKey: crypto.randomUUID(),
          }
        : actionSchema.parse(JSON.parse(saved));
    if (action.operationId !== operation.id)
      throw new Error(
        "Recover the earlier pending operation before approving another"
      );
    window.localStorage.setItem(pendingKey, JSON.stringify(action));
    return submitSaved(action);
  });
}

/** Resume the exact stored action after reload without preparing another transaction. */
export async function resumePendingOperation(): Promise<EarnOperation | null> {
  return withOperationLock(async () => {
    const saved = window.localStorage.getItem(pendingKey);
    return saved === null
      ? null
      : submitSaved(actionSchema.parse(JSON.parse(saved)));
  });
}

async function updatePreparedOperation(
  operationId: string,
  {
    action,
    input,
  }:
    | { action: "cancel"; input: Record<string, never> }
    | {
        action: "refresh";
        input: { actionId: string; version: number; optionId?: string };
      }
): Promise<EarnOperation> {
  return withOperationLock(async () => {
    assertNoPendingSubmission();
    const keyName = `northstar:${action}:${operationId}:${JSON.stringify(input)}`;
    const key = window.localStorage.getItem(keyName) ?? crypto.randomUUID();
    window.localStorage.setItem(keyName, key);
    const operation = await request(
      `/api/operations/${encodeURIComponent(operationId)}/${action}`,
      { ...input, idempotencyKey: key }
    );
    window.localStorage.removeItem(keyName);
    return operation;
  });
}

export function requestOperationCancellation(
  operationId: string
): Promise<EarnOperation> {
  return updatePreparedOperation(operationId, { action: "cancel", input: {} });
}

/** Refresh is available only when the API can safely replace an unsigned action. */
export function refreshPreparedOperation(
  operation: EarnOperation,
  optionId?: string
): Promise<EarnOperation> {
  return updatePreparedOperation(operation.id, {
    action: "refresh",
    input: {
      actionId: operation.actionId,
      version: operation.version,
      ...(optionId ? { optionId } : {}),
    },
  });
}
