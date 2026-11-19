import { findSafeProxyOperation, type SafeProxyCaller } from "@sdp/safe-proxy-catalog/catalog";
import {
  type CredentialReference,
  type SafeProxyResponseEnvelope,
  safeProxyRequestEnvelopeSchema,
} from "@sdp/safe-proxy-catalog/envelope";
import {
  SAFE_PROXY_ERROR_HTTP_STATUS,
  SafeProxyError,
  type SafeProxyErrorCode,
  type SafeProxyOutcome,
} from "@sdp/safe-proxy-catalog/errors";
import type { SafeProxyHandlers } from "@sdp/safe-proxy-catalog/handlers";
import type { CallerCredentials, ResolveCaller } from "@/caller";

/** The one line written per request. It never carries a credential, a request body or a provider response. */
export type RequestLogLine = {
  requestId: string | null;
  caller: SafeProxyCaller | null;
  provider: string;
  operation: string;
  organizationId: string | null;
  projectId: string | null;
  outcome: "ok" | SafeProxyOutcome;
  code: SafeProxyErrorCode | null;
  /** The class of an unexpected error, never its message. */
  errorType: string | null;
  durationMs: number;
};

export type DispatchDependencies = {
  resolveCaller: ResolveCaller;
  handlers: SafeProxyHandlers;
  log: (line: RequestLogLine) => void;
};

export type DispatchRequest = {
  section: string;
  name: string;
  credentials: CallerCredentials;
  /** The parsed JSON body, or undefined when the body was not JSON. */
  body: unknown;
};

type DispatchAnswer = { status: number; body: SafeProxyResponseEnvelope };

type UntypedHandler = (request: {
  requestId: string;
  caller: SafeProxyCaller;
  signal: AbortSignal;
  input: unknown;
  credential?: CredentialReference;
  idempotencyKey?: string;
}) => Promise<unknown>;

function findHandler(handlers: SafeProxyHandlers, section: string, name: string): UntypedHandler {
  // SAFETY: called only after findSafeProxyOperation found this operation, and SafeProxyHandlers
  // has one handler per catalog operation; the input passed to it was parsed against that
  // operation's request schema.
  const untyped = handlers as Record<string, Record<string, UntypedHandler>>;
  const handler = untyped[section]?.[name];
  if (handler === undefined) {
    throw new Error(`No handler for ${section}.${name}`);
  }
  return handler;
}

/**
 * Every request passes through here, in this order: who is calling, whether the operation exists,
 * whether this caller may use it, whether the envelope fits, then the handler under the budget.
 * A failure at any step is answered with a code and an outcome. Nothing is retried.
 */
export async function dispatch(
  dependencies: DispatchDependencies,
  request: DispatchRequest
): Promise<DispatchAnswer> {
  const startedAt = performance.now();
  const operation = findSafeProxyOperation(request.section, request.name);
  const line: RequestLogLine = {
    requestId: null,
    caller: null,
    // A path is caller-chosen until it matches the catalog, so only catalog names are logged.
    provider: operation === undefined ? "unknown" : request.section,
    operation: operation === undefined ? "unknown" : request.name,
    organizationId: null,
    projectId: null,
    outcome: "ok",
    code: null,
    errorType: null,
    durationMs: 0,
  };

  let answer: DispatchAnswer;
  try {
    const caller = await dependencies.resolveCaller(request.credentials);
    line.caller = caller;

    if (operation === undefined) {
      throw new SafeProxyError({ code: "unknown_operation", outcome: "rejected" });
    }
    if (!operation.callers.includes(caller)) {
      throw new SafeProxyError({ code: "caller_not_allowed", outcome: "rejected" });
    }

    const envelope = safeProxyRequestEnvelopeSchema(operation).safeParse(request.body);
    if (!envelope.success) {
      throw new SafeProxyError({ code: "invalid_request", outcome: "rejected" });
    }
    line.requestId = envelope.data.requestId;
    line.organizationId = envelope.data.credential?.organizationId ?? null;
    line.projectId = envelope.data.credential?.projectId ?? null;

    const signal = AbortSignal.timeout(Math.min(envelope.data.budgetMs, operation.budgetMs));
    const budgetSpent = new Promise<never>((_, reject) => {
      signal.addEventListener(
        "abort",
        // The handler may already have sent its call, so running out of time is never `rejected`.
        () => reject(new SafeProxyError({ code: "deadline_exceeded", outcome: "no_answer" })),
        { once: true }
      );
    });
    const handled = findHandler(
      dependencies.handlers,
      request.section,
      request.name
    )({
      requestId: envelope.data.requestId,
      caller,
      signal,
      input: envelope.data.input,
      credential: envelope.data.credential,
      idempotencyKey: envelope.data.idempotencyKey,
    });
    // Once the budget has answered, a late handler failure has nowhere to go.
    handled.catch(() => undefined);
    const output = await Promise.race([handled, budgetSpent]);

    const declared = operation.response.safeParse(output);
    if (!declared.success) {
      throw new SafeProxyError({ code: "internal", outcome: "no_answer" });
    }
    answer = { status: 200, body: { ok: true, output: declared.data } };
  } catch (error) {
    let failure: SafeProxyError;
    if (error instanceof SafeProxyError) {
      failure = error;
    } else {
      failure = new SafeProxyError({ code: "internal", outcome: "no_answer" });
      line.errorType = error instanceof Error ? error.name : typeof error;
    }
    line.outcome = failure.outcome;
    line.code = failure.code;
    answer = {
      status: SAFE_PROXY_ERROR_HTTP_STATUS[failure.code],
      body: { ok: false, error: failure.failure },
    };
  }

  line.durationMs = Math.round(performance.now() - startedAt);
  dependencies.log(line);
  return answer;
}
