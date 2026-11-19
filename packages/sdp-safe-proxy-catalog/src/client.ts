import type { z } from "zod";
import {
  type SafeProxyCatalog,
  type SafeProxyOperation,
  type SafeProxySection,
  safeProxyCatalog,
} from "./catalog";
import {
  type CredentialReference,
  SAFE_PROXY_CALLER_GRACE_MS,
  type SafeProxyDeclaredFields,
  type SafeProxyRequestEnvelope,
  safeProxyCallPath,
  safeProxyResponseEnvelopeSchema,
} from "./envelope";
import { SafeProxyError } from "./errors";

/**
 * Sends one envelope and returns whatever came back. It throws only when no response arrived, and
 * it gives up after `timeoutMs`.
 */
export type SafeProxyTransport = (call: {
  path: string;
  envelope: SafeProxyRequestEnvelope;
  timeoutMs: number;
}) => Promise<{ status: number; body: unknown }>;

export type SafeProxyClientOptions = {
  transport: SafeProxyTransport;
  /** The id of the request being served, so a Safe Proxy log line can be tied to it. */
  requestId: () => string;
};

type SafeProxyCallArguments<Operation extends SafeProxyOperation> = {
  input: z.input<Operation["request"]>;
} & SafeProxyDeclaredFields<Operation>;

export type SafeProxyClient = {
  readonly [Section in SafeProxySection]: {
    readonly [Name in keyof SafeProxyCatalog[Section]]: SafeProxyCatalog[Section][Name] extends SafeProxyOperation
      ? (
          call: SafeProxyCallArguments<SafeProxyCatalog[Section][Name]>
        ) => Promise<z.output<SafeProxyCatalog[Section][Name]["response"]>>
      : never;
  };
};

type UntypedCallArguments = {
  input: z.input<SafeProxyOperation["request"]>;
  credential?: CredentialReference;
  idempotencyKey?: string;
};

async function callOperation(
  options: SafeProxyClientOptions,
  path: string,
  operation: SafeProxyOperation,
  call: UntypedCallArguments
): Promise<z.output<SafeProxyOperation["response"]>> {
  const envelope: SafeProxyRequestEnvelope = {
    requestId: options.requestId(),
    budgetMs: operation.budgetMs,
    credential: call.credential,
    idempotencyKey: call.idempotencyKey,
    input: call.input,
  };

  let answer: Awaited<ReturnType<SafeProxyTransport>>;
  try {
    answer = await options.transport({
      path,
      envelope,
      timeoutMs: operation.budgetMs + SAFE_PROXY_CALLER_GRACE_MS,
    });
  } catch (cause) {
    throw new SafeProxyError({ code: "proxy_unreachable", outcome: "no_answer" }, { cause });
  }

  const parsed = safeProxyResponseEnvelopeSchema(operation).safeParse(answer.body);
  if (!parsed.success) {
    // Not an answer from the service itself. The platform refuses an unauthorised caller before
    // the request reaches it; anything else may have been cut off after the operation ran.
    if (answer.status === 401 || answer.status === 403) {
      throw new SafeProxyError({ code: "caller_not_allowed", outcome: "rejected" });
    }
    throw new SafeProxyError({ code: "proxy_unreachable", outcome: "no_answer" });
  }
  if (parsed.data.ok) {
    return parsed.data.output;
  }
  throw new SafeProxyError(parsed.data.error);
}

/** Turns the catalog into `safeProxy.<section>.<operation>(...)`. */
export function createSafeProxyClient(options: SafeProxyClientOptions): SafeProxyClient {
  const sections = Object.entries(safeProxyCatalog).map(([section, operations]) => [
    section,
    Object.fromEntries(
      Object.entries(operations).map(([name, operation]) => [
        name,
        (call: UntypedCallArguments) =>
          callOperation(options, safeProxyCallPath(section, name), operation, call),
      ])
    ),
  ]);
  // SAFETY: built from the same catalog the type is mapped over, one function per operation; each
  // function checks the answer against that operation's response schema before returning it.
  return Object.fromEntries(sections) as SafeProxyClient;
}
