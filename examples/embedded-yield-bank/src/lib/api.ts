import { z } from "zod";
import type {
  ApiErrorBody,
  DashboardData,
  TransferResult,
  WithdrawalCancellationResult,
  WithdrawalIntent,
  WithdrawalResult,
} from "@/types";
import { intentResultSchema } from "./intent-result";
import { preparedIntentSchema } from "./prepared-intent";

export class ApiError extends Error {
  readonly status: number;
  /** How long the server asked us to wait before asking again. */
  readonly retryAfterMs: number | undefined;

  constructor(status: number, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export async function getDashboard(
  activeMovementIds: readonly string[] = []
): Promise<DashboardData> {
  const search = new URLSearchParams();
  for (const movementId of activeMovementIds) {
    search.append("movementId", movementId);
  }
  const query = search.toString();
  return request<DashboardData>(`/api/dashboard${query ? `?${query}` : ""}`);
}

const STORAGE_KEY = "northstar:pending-intent:v1";
const pendingSchema = z.object({
  fingerprint: z.string(),
  intent: preparedIntentSchema,
});

function pendingIntent() {
  const raw = window.localStorage.getItem(STORAGE_KEY);
  // Malformed saved state must block new signing, never silently discard intent.
  return raw === null ? null : pendingSchema.parse(JSON.parse(raw));
}

async function withIntentLock<T>(work: () => Promise<T>): Promise<T> {
  if (!navigator.locks)
    throw new Error(
      "This browser cannot safely save and retry transfers. Use a browser with Web Locks support."
    );
  return navigator.locks.request(STORAGE_KEY, work);
}

async function submitPending(pending: z.infer<typeof pendingSchema>) {
  const result = intentResultSchema.parse(
    await request<unknown>("/api/intents/submit", {
      method: "POST",
      body: JSON.stringify(pending.intent),
    })
  );
  const expected =
    pending.intent.kind === "deposit" || pending.intent.kind === "withdrawal"
      ? "movement"
      : pending.intent.kind;
  if (result.kind !== expected)
    throw new Error("Transfer response does not match the saved request");
  // Only a validated durable result retires intent, never an HTTP error, timeout,
  // malformed 2xx, or the signed transaction's blockhash expiry.
  window.localStorage.removeItem(STORAGE_KEY);
  return result;
}

async function executeIntent(path: string, input: unknown) {
  return withIntentLock(async () => {
    const fingerprint = JSON.stringify([path, input]);
    let pending = pendingIntent();
    if (pending && pending.fingerprint !== fingerprint) {
      throw new Error(
        "An earlier transfer is awaiting confirmation. Keep this page open while it is recovered before starting another transfer."
      );
    }
    if (!pending) {
      const prepared = z.object({ intent: preparedIntentSchema }).parse(
        await request<unknown>(path, {
          method: "POST",
          body: JSON.stringify(input),
        })
      );
      pending = { fingerprint, intent: prepared.intent };
      // Preparation signs but never broadcasts. If saving throws, nothing is sent.
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(pending));
    }
    return submitPending(pending);
  });
}

/** Resume saved bytes after reload; the server never needs an in-memory journal. */
export async function resumePendingIntent() {
  return withIntentLock(async () => {
    const pending = pendingIntent();
    return pending ? submitPending(pending) : null;
  });
}

export async function createDeposit(amount: string): Promise<TransferResult> {
  const result = await executeIntent("/api/deposits", { amount });
  if (result.kind !== "movement") throw new Error("Invalid deposit response");
  return { movement: result.movement };
}

export async function createWithdrawal(
  input: WithdrawalIntent
): Promise<WithdrawalResult> {
  const result = await executeIntent("/api/withdrawals", input);
  if (result.kind === "cancel") throw new Error("Invalid withdrawal response");
  return result;
}

export async function cancelQueuedWithdrawal(
  withdrawalRequestId: string
): Promise<WithdrawalCancellationResult> {
  const result = await executeIntent("/api/withdrawal-cancellations", {
    withdrawalRequestId,
  });
  if (result.kind !== "cancel")
    throw new Error("Invalid cancellation response");
  return { withdrawalRequest: result.withdrawalRequest };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Resolve against the origin, not the document URL: a page opened as
  // user:pass@host keeps those credentials in its URL, and fetch refuses them.
  const response = await fetch(new URL(path, window.location.origin), {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const payload = (await response.json().catch(() => null)) as
    | ({ data?: T } & ApiErrorBody)
    | null;

  if (!response.ok) {
    const retryAfter = Number(response.headers.get("retry-after"));
    throw new ApiError(
      response.status,
      payload?.error?.message ?? `Request failed with ${response.status}`,
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1_000
        : undefined
    );
  }
  if (!payload?.data)
    throw new Error("The demo server returned an invalid response");
  return payload.data;
}
