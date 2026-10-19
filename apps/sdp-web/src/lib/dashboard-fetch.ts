import { isBodylessHttpStatus } from "@sdp/types/idempotency";
import type { IdempotencyRequiredRoute } from "@sdp/types/idempotency-required-routes";
import { isMoneyMovementStatus, type MoneyMovementStatus } from "@sdp/types/payments";
import { z } from "zod";
import { readApiErrorMessage } from "./api-error";
import { parseDashboardPathname } from "./dashboard-project-path";
import {
  type ApiAnswer,
  answerRetiresKey,
  apiErrorCode,
  IDEMPOTENCY_KEY_HEADER,
  isMovementInFlight,
  moneyAnswerRetiresKey,
  movementStatusOf,
  storageFingerprint,
} from "./idempotency";
import {
  createIdempotencyKeyStore,
  type IdempotencyKeyStore,
  idempotencyKeyScope,
} from "./idempotency-key-store";
import { TAB_DEMO_HEADER_NAME } from "./payments-demo/demo-cookie";
import { PROJECT_HEADER_NAME } from "./project-cookie";

export type DashboardFetchResult<T> =
  | {
      ok: true;
      data: T;
      status: number;
      /**
       * A success whose body is not the backend's readable answer (empty, not
       * JSON, or a followed redirect): the key's store keeps the key
       * ({@link answerOf}), so anything frozen with it is kept too.
       */
      unreadable?: boolean;
    }
  | {
      ok: false;
      error: string;
      status: number | null;
      body: unknown;
      /** sdp-api marked the answer `Idempotent-Replayed`: a stored answer to an earlier attempt. */
      replayed?: boolean;
      /** sdp-api's error code, when the body names one. */
      code?: string | null;
      /**
       * The response is not the backend's readable answer (a body that would not
       * download or parse), so it says nothing about the write: the key is kept,
       * and so is anything frozen with it (`fetchResultAnswer`).
       */
      unreadable?: boolean;
    };

export interface DashboardFetchOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Headers supplied by the caller; only the Project is taken from the tab's URL. */
  headers?: HeadersInit;
  body?: unknown;
  signal?: AbortSignal;
}

let tabShowsDemo = false;

/**
 * Set by the dashboard shell: whether this tab is showing Payments demo mode, so the calls it
 * makes say so (see {@link TAB_DEMO_HEADER_NAME}).
 *
 * @param on - True while the tab shows demo mode.
 */
export function setTabShowsDemo(on: boolean): void {
  tabShowsDemo = on;
}

/**
 * The dashboard proxy route for each API route that requires an
 * Idempotency-Key. `satisfies` makes the map exhaustive: a route added to the
 * shared list fails this build until it is mapped here.
 */
const DASHBOARD_REQUIRED_ROUTES = {
  "POST /v1/payments/transfers": "POST /api/dashboard/payments/transfers",
  "POST /v1/payments/transfer-batches": "POST /api/dashboard/payments/transfers/batch",
  "POST /v1/payments/recurring-payments": "POST /api/dashboard/payments/recurring-payments",
  "PATCH /v1/payments/recurring-payments/:id":
    "PATCH /api/dashboard/payments/recurring-payments/:id",
  "POST /v1/payments/recurring-payments/:id/activate":
    "POST /api/dashboard/payments/recurring-payments/:id/activate",
  "POST /v1/payments/recurring-payments/:id/cancel":
    "POST /api/dashboard/payments/recurring-payments/:id/cancel",
  "POST /v1/payments/recurring-payments/:id/collect":
    "POST /api/dashboard/payments/recurring-payments/:id/collect",
  "POST /v1/payments/recurring-payments/:id/resume":
    "POST /api/dashboard/payments/recurring-payments/:id/resume",
} as const satisfies Record<IdempotencyRequiredRoute, string>;

function matchesRoute(pattern: string, method: string, path: string): boolean {
  const [patternMethod, patternPath = ""] = pattern.split(" ", 2);
  if (patternMethod !== method) return false;
  const pathname = path.split("?", 1)[0] ?? path;
  const expected = patternPath.split("/");
  const actual = pathname.split("/");
  return (
    expected.length === actual.length &&
    expected.every((segment, index) => segment.startsWith(":") || segment === actual[index])
  );
}

/** Whether this mutation moves money, so it must never send under a key that cannot be kept. */
function requiresPersistedKey(method: string, path: string): boolean {
  return Object.values(DASHBOARD_REQUIRED_ROUTES).some((pattern) =>
    matchesRoute(pattern, method, path)
  );
}

const KEYED_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

let mutationKeyStore: IdempotencyKeyStore | null = null;

/**
 * Created on first use, never at import: server routes import this module, and
 * the store is a client function that the server may not call.
 */
function mutationKeys(): IdempotencyKeyStore {
  mutationKeyStore ??= createIdempotencyKeyStore("sdp:dashboard:mutation:idempotency:v1");
  return mutationKeyStore;
}
const inFlightMutations = new Map<string, Promise<Response>>();

/**
 * Whether a response is the dashboard backend's own answer: never a redirect
 * `fetch` followed (an expired session sent to sign-in comes back as an HTML
 * 200), and JSON unless it carries no body. Anything else says nothing about
 * the write, so it never retires the key.
 */
function isApiAnswer(response: Response): boolean {
  if (response.redirected) return false;
  if (isBodylessHttpStatus(response.status)) return true;
  return response.headers.get("content-type")?.toLowerCase().includes("application/json") ?? false;
}

/**
 * What the backend answered, or `null` when the response says nothing about
 * the write: not the backend's answer ({@link isApiAnswer}), or a body that is
 * not the JSON it claims to be. A create whose answer cannot be read keeps its
 * key, so the retry is answered by the API's replay instead of running again
 * under a new key.
 */
function answerOf(response: Response, text: string): ApiAnswer | null {
  if (!isApiAnswer(response)) return null;
  const replayed = response.headers.get("Idempotent-Replayed") === "true";
  if (isBodylessHttpStatus(response.status)) {
    return { status: response.status, replayed, code: null };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  if (response.ok) {
    return {
      status: response.status,
      replayed,
      code: null,
      movementStatus: movementStatusOf(json),
    };
  }
  return { status: response.status, replayed, code: apiErrorCode(text) };
}

/**
 * Whether an answer retires the key, so the next submit is a new action: only
 * a readable backend answer can ({@link answerOf}), on the dashboard-wide rule
 * (`answerRetiresKey`).
 */
function retiresKey(response: Response, body: ArrayBuffer, movesMoney: boolean): boolean {
  const answer = answerOf(response, new TextDecoder().decode(body));
  if (answer === null) return false;
  return movesMoney ? moneyAnswerRetiresKey(answer) : answerRetiresKey(answer);
}

/**
 * The GET path that shows when a kept money answer's movement is final, or
 * `null` for none. The only money routes keyed here are recurring (transfers
 * and batches keep their own keys). A collect is final when its collection's
 * own transfer is, so it reads that transfer (`transfer.id`, else the
 * attempt's `transferId`); with neither, nothing the dashboard can read shows
 * the attempt's status, so the key simply stays kept. Any other recurring
 * answer reads its schedule.
 */
function inFlightMovementReadPath(body: ArrayBuffer): string | null {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  }
  const parsed = keptMovementBodySchema.safeParse(json);
  if (!parsed.success || !isMovementInFlight(movementStatusOf(json))) return null;
  const { transfer, collectionAttempt, recurringPayment } = parsed.data.data;
  if (collectionAttempt !== undefined) {
    const transferId = transfer?.id ?? collectionAttempt.transferId;
    return transferId ? MOVEMENT_READ_PATHS.transfer(transferId) : null;
  }
  return recurringPayment === undefined
    ? null
    : MOVEMENT_READ_PATHS.recurringPayment(recurringPayment.id);
}

function sendWithProject(
  path: string,
  init: RequestInit,
  headers: Headers,
  demo: boolean = tabShowsDemo
): Promise<Response> {
  const { projectId } = parseDashboardPathname(window.location.pathname);
  if (projectId !== null) {
    headers.set(PROJECT_HEADER_NAME, projectId);
  }
  if (demo) {
    headers.set(TAB_DEMO_HEADER_NAME, "1");
  }
  return fetch(path, { ...init, headers });
}

/**
 * The action a submit stands for: Project, demo or live mode, method, path and
 * body. The mode is part of it, so a live submit never joins a demo request of
 * the same body, or reuses its key.
 */
function actionMaterial(path: string, init: RequestInit, demo: boolean): string {
  const { projectId } = parseDashboardPathname(window.location.pathname);
  return JSON.stringify([projectId, demo, init.method, path, init.body ?? ""]);
}

function abortable(response: Promise<Response>, signal: AbortSignal | null | undefined) {
  if (!signal) return response;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<Response>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    response.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Sends a `stable` mutation under one Idempotency-Key per user action: the
 * key is minted for the (Project, method, path, body) the user submitted and
 * reused by every retry and double-click of that same action until the answer
 * (headers and body) retires it ({@link retiresKey}). The key is kept before
 * the request goes out, so an unanswered write (a reload, a network failure,
 * a 5xx) keeps it for the retry. A second
 * identical submit while the first is in flight joins it, and one caller
 * aborting never cancels the shared request.
 */
async function sendUnderActionKey(
  path: string,
  init: RequestInit,
  headers: Headers
): Promise<Response> {
  // Joined synchronously, before any await, so a double submit can never race
  // past the check. The in-memory map may hold the raw action; storage may not.
  // A call cancelled before it starts never claims a key or sends anything.
  if (init.signal?.aborted) {
    throw init.signal.reason;
  }
  // The mode is fixed at submit, and the request is sent in that mode.
  const demo = tabShowsDemo;
  const material = actionMaterial(path, init, demo);
  // Joined only within the signed-in user and org: after a switch in this tab,
  // the same submit is the new user's own request, never the first one's answer.
  const joinKey = JSON.stringify([idempotencyKeyScope(), material]);
  let sent = inFlightMutations.get(joinKey);
  if (!sent) {
    const { signal: _callerSignal, ...shared } = init;
    const fingerprint = storageFingerprint(material);
    const keys = mutationKeys();
    const kept = keys.has(fingerprint);
    // Kept before the request goes out, so a reload mid-flight finds it. When
    // browser storage refuses the write (private mode, quota), the key lives in
    // memory only: retries in this page still reuse it, but a reload cannot. A
    // money movement refuses to send then, since a reload and retry could move
    // it twice; any other mutation sends, as a duplicate costs at most a replay.
    const { key, persisted } = keys.claim(fingerprint);
    headers.set(IDEMPOTENCY_KEY_HEADER, key);
    if (!persisted) {
      if (requiresPersistedKey(init.method ?? "GET", path)) {
        // Only a key this call minted is dropped: a kept one belongs to an
        // earlier attempt that may have written, and its retry still needs it.
        if (!kept) keys.release(fingerprint, key);
        return keyNotPersistedResponse();
      }
      console.warn("Idempotency-Key not persisted; a reload will not recover it");
    }
    sent = sendWithProject(path, shared, headers, demo).then(async (response) => {
      // The answer only counts once its body has arrived: a download that
      // fails leaves the key pinned, so the retry recovers the first result.
      const body = await response.arrayBuffer();
      const movesMoney = requiresPersistedKey(init.method ?? "GET", path);
      if (retiresKey(response, body, movesMoney)) {
        keys.release(fingerprint, key);
      } else if (movesMoney && response.ok) {
        const readPath = inFlightMovementReadPath(body);
        if (readPath !== null) {
          settleWhenMovementFinal(readPath, () => keys.release(fingerprint, key));
        }
      }
      return new Response(isBodylessHttpStatus(response.status) ? null : body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    });
    inFlightMutations.set(joinKey, sent);
    void sent.finally(() => inFlightMutations.delete(joinKey)).catch(() => undefined);
  }
  // Every caller gets its own copy, so each can read the body.
  return (await abortable(sent, init.signal)).clone();
}

/**
 * Dashboard routes this layer never keys, each for a reason:
 * - the API playground sends exactly the request the user composed, including
 *   one that carries a pasted API secret;
 * - DvP manages its own keys: a fresh one per fund or reclaim press, none on
 *   settle or cancel (PRO-1993 owns that choice).
 */
const UNKEYED_PREFIXES = ["/api/playground/", "/api/dashboard/markets/dvp/"] as const;

/**
 * Read-like POSTs, never keyed: an estimate, a quote or a simulation (the
 * ramps sandbox's `/simulate` included) writes nothing a retry could repeat,
 * and they fire as the user types, so each would leave an unanswered key
 * behind that never expires.
 */
const READ_LIKE_POST = /\/(estimate|quote|simulate)$/;

/**
 * Every mutation the dashboard sends takes a key per user action, whatever
 * module it reaches: a route that ignores the header loses nothing, and no
 * second list of routes can drift from the API's. The exceptions are
 * {@link UNKEYED_PREFIXES} and {@link READ_LIKE_POST}.
 */
function takesActionKey(path: string, init: RequestInit, headers: Headers): boolean {
  const method = (init.method ?? "GET").toUpperCase();
  return (
    KEYED_METHODS.has(method) &&
    !UNKEYED_PREFIXES.some((prefix) => path.startsWith(prefix)) &&
    !READ_LIKE_POST.test(path.split("?", 1)[0] ?? path) &&
    !headers.has(IDEMPOTENCY_KEY_HEADER) &&
    (init.body === undefined || init.body === null || typeof init.body === "string")
  );
}

/** The refusal a money movement gets when its key cannot be kept across a reload. */
function keyNotPersistedResponse(): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: "IDEMPOTENCY_KEY_NOT_PERSISTED",
        message:
          "This browser is not keeping the request's retry key (private browsing or storage full), so the payment was not sent. Allow site storage and try again.",
      },
    }),
    { status: 428, headers: { "content-type": "application/json" } }
  );
}

/**
 * `fetch` for the dashboard backend from the browser: sends the Project in this
 * tab's URL as `x-project-id`, so the request acts on the Project the tab
 * renders whatever another tab has selected since (HOO-1965). Outside a
 * Project-scoped URL no header is sent and Project-scoped backend routes
 * refuse the request.
 *
 * A `stable` module mutation without a caller-chosen Idempotency-Key gets one
 * per user action (see `sendUnderActionKey`). Flows that keep their own key
 * (transfers, batches) send through {@link dashboardRequestUnderOwnKey}.
 *
 * @param path - Dashboard backend path, e.g. `/api/dashboard/payments/transfers`.
 * @param init - Standard fetch options; a caller-set `x-project-id` is overwritten.
 * @returns The raw backend response.
 */
export function dashboardRequest(path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  if (takesActionKey(path, init, headers)) {
    return sendUnderActionKey(
      path,
      { ...init, method: (init.method ?? "GET").toUpperCase() },
      headers
    );
  }
  return sendWithProject(path, init, headers);
}

/** A key its caller keeps in its own store, and whether that store persisted it. */
export interface CallerIdempotencyKey {
  value: string;
  /** False when browser storage refused the key, so a reload would lose it. */
  persisted: boolean;
}

/**
 * {@link dashboardRequest} for a flow that keeps its own key (transfers,
 * batches), under the same rule as `sendUnderActionKey`: a money movement
 * whose key the browser could not persist is refused with the same 428, and
 * nothing is sent, since a reload and retry could move it twice.
 *
 * @param path - Dashboard backend path.
 * @param init - Standard fetch options.
 * @param key - The caller's key, and whether its store persisted it.
 * @returns The raw backend response, or the local 428 refusal.
 */
export async function dashboardRequestUnderOwnKey(
  path: string,
  init: RequestInit,
  key: CallerIdempotencyKey
): Promise<Response> {
  if (!key.persisted) {
    if (requiresPersistedKey((init.method ?? "GET").toUpperCase(), path)) {
      return keyNotPersistedResponse();
    }
    console.warn("Idempotency-Key not persisted; a reload will not recover it");
  }
  const headers = new Headers(init.headers);
  headers.set(IDEMPOTENCY_KEY_HEADER, key.value);
  return sendWithProject(path, init, headers);
}

/** Where the dashboard reads a money movement's current state, by its record kind. */
export const MOVEMENT_READ_PATHS = {
  transfer: (id: string) => `/api/dashboard/payments/transfers/${encodeURIComponent(id)}`,
  batch: (id: string) => `/api/dashboard/payments/transfers/batch/${encodeURIComponent(id)}`,
  recurringPayment: (id: string) =>
    `/api/dashboard/payments/recurring-payments/${encodeURIComponent(id)}`,
  privateChannelTransfer: (id: string) =>
    `/api/dashboard/private-channels/transfers/${encodeURIComponent(id)}`,
} as const;

/** A private-channel transfer read answers with the transfer itself as `data`. */
const privateChannelTransferReadSchema = z.object({ data: z.object({ status: z.string() }) });

/**
 * The status a private-channel transfer read shows, for
 * {@link settleWhenMovementFinal}: that GET answers with the transfer as
 * `data`, not under `data.transfer`.
 */
export function privateChannelTransferStatusOf(json: unknown): MoneyMovementStatus | null {
  const parsed = privateChannelTransferReadSchema.safeParse(json);
  return parsed.success && isMoneyMovementStatus(parsed.data.data.status)
    ? parsed.data.data.status
    : null;
}

export const MOVEMENT_POLL_INTERVAL_MS = 3_000;
export const MOVEMENT_POLL_ATTEMPTS = 40;
const watchedMovements = new Set<string>();

/** @internal Test-only: forget every running movement watch. */
export function resetMovementWatchesForTests(): void {
  watchedMovements.clear();
}

/**
 * Settles a money key that was kept because its answer showed the movement
 * still under way (APE-461). sdp-api replays a key's first 2xx verbatim, so a
 * same-key retry repeats that `processing` snapshot and can never settle the
 * key; the resource's current state can. Reads `readPath` with GET every
 * {@link MOVEMENT_POLL_INTERVAL_MS} until it shows a final status, then calls
 * `settle`. After {@link MOVEMENT_POLL_ATTEMPTS} reads it stops and the key
 * stays kept; the next send under it starts a new watch. One watch per path.
 *
 * @param readPath - The movement's GET path ({@link MOVEMENT_READ_PATHS}).
 * @param settle - Retires the kept key.
 * @param statusOf - Reads the movement's status from the GET body.
 */
export function settleWhenMovementFinal(
  readPath: string,
  settle: () => void,
  statusOf: (json: unknown) => MoneyMovementStatus | null = movementStatusOf
): void {
  if (watchedMovements.has(readPath)) return;
  watchedMovements.add(readPath);
  let attempts = 0;
  const read = async () => {
    attempts += 1;
    try {
      const response = await dashboardRequest(readPath, { method: "GET", cache: "no-store" });
      const status = response.ok ? statusOf(await response.json()) : null;
      if (status !== null && !isMovementInFlight(status)) {
        watchedMovements.delete(readPath);
        settle();
        return;
      }
    } catch {
      // A failed read says nothing about the movement: read again next tick.
    }
    if (attempts >= MOVEMENT_POLL_ATTEMPTS) {
      watchedMovements.delete(readPath);
      return;
    }
    setTimeout(read, MOVEMENT_POLL_INTERVAL_MS);
  };
  setTimeout(read, MOVEMENT_POLL_INTERVAL_MS);
}

/** The records a kept recurring answer names, as far as their ids go. */
const keptMovementBodySchema = z.object({
  data: z.object({
    transfer: z.object({ id: z.string() }).optional(),
    collectionAttempt: z.object({ transferId: z.string().nullish() }).optional(),
    recurringPayment: z.object({ id: z.string() }).optional(),
  }),
});

export async function dashboardFetch<T = unknown>(
  path: string,
  options: DashboardFetchOptions = {}
): Promise<DashboardFetchResult<T>> {
  const { method = "GET", headers: suppliedHeaders, body, signal } = options;
  const headers = new Headers(suppliedHeaders);
  if (body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  let response: Response;
  try {
    response = await dashboardRequest(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Network error",
      status: null,
      body: null,
    };
  }

  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Network error",
      status: response.status,
      body: null,
      unreadable: true,
    };
  }

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    let errorBody: unknown = text;
    try {
      const json: unknown = JSON.parse(text);
      errorBody = json;
      message = readApiErrorMessage(json) ?? message;
    } catch {}
    return {
      ok: false,
      error: message,
      status: response.status,
      body: errorBody,
      replayed: response.headers.get("Idempotent-Replayed") === "true",
      code: apiErrorCode(text),
      // The same decision the key's store made ({@link answerOf}).
      unreadable: answerOf(response, text) === null,
    };
  }

  try {
    const data = (text ? JSON.parse(text) : null) as T;
    // The same decision the key's store made ({@link answerOf}).
    return answerOf(response, text) === null
      ? { ok: true, data, status: response.status, unreadable: true }
      : { ok: true, data, status: response.status };
  } catch {
    return { ok: false, error: "Invalid response", status: response.status, body: text };
  }
}
