import { credentialReferenceSchema } from "@sdp/safe-proxy-endpoints/credential-reference";
import type { AllowedEndpoint } from "@sdp/safe-proxy-endpoints/endpoint";
import { matchEndpoint } from "@sdp/safe-proxy-endpoints/match";
import { FORWARD_HEADERS } from "@sdp/safe-proxy-endpoints/protocol";
import { SAFE_PROXY_PROVIDERS, type SafeProxyProvider } from "@sdp/safe-proxy-endpoints/providers";
import type { Context } from "hono";
import { z } from "zod";
import type { IdentifyCaller } from "./caller";
import type { CredentialLoader, ProviderCredentials } from "./credentials";
import type { AuthHeaders, AuthInjection, InjectionRequest } from "./providers/injection";
import { AUTH_INJECTIONS } from "./providers/registry";
import { Refusal } from "./refusal";
import type { Progress } from "./request-result";

export type AppEnv = {
  Variables: { receivedAt: number; requestId: string | null; progress: Progress };
};

export interface ForwardDependencies {
  identifyCaller: IdentifyCaller;
  loadCredential: CredentialLoader;
  fetch: typeof fetch;
  now: () => number;
  maxBudgetMs: number;
}

const ROUTE_PREFIX = "/v1/forward/";
export const FORWARD_ROUTE = `${ROUTE_PREFIX}*`;

const MAX_BODY_BYTES = 1024 * 1024;

const CARRIES_BODY = { GET: false, POST: true } as const satisfies Record<
  AllowedEndpoint["method"],
  boolean
>;

// A provider with a second host needs a rule for choosing between them before it fits here.
const PROVIDER_HOSTS: Record<SafeProxyProvider, readonly [string]> = {
  fireblocks: SAFE_PROXY_PROVIDERS.fireblocks.hosts,
  privy: SAFE_PROXY_PROVIDERS.privy.hosts,
};

const AUTH_BY_PROVIDER: {
  [Provider in SafeProxyProvider]: AuthInjection<ProviderCredentials[Provider]>;
} = {
  fireblocks: AUTH_INJECTIONS[SAFE_PROXY_PROVIDERS.fireblocks.authScheme],
  privy: AUTH_INJECTIONS[SAFE_PROXY_PROVIDERS.privy.authScheme],
};

const requestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const budgetSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,8}$/)
  .transform(Number);

export function readRequestId(header: string | undefined): string | null {
  const requestId = requestIdSchema.safeParse(header);
  return requestId.success ? requestId.data : null;
}

function readBudgetMs(header: string | undefined, maxBudgetMs: number): number {
  const budgetMs = budgetSchema.safeParse(header);
  if (!budgetMs.success || budgetMs.data > maxBudgetMs) throw new Refusal("invalid_request");
  return budgetMs.data;
}

// The provider and the provider's own request target, as they follow the route prefix.
function providerRequest(url: string): { provider: string; target: string } {
  const { pathname, search } = new URL(url);
  const rest = pathname.slice(ROUTE_PREFIX.length);
  const slash = rest.indexOf("/");
  const providerEnd = slash === -1 ? rest.length : slash;
  return { provider: rest.slice(0, providerEnd), target: rest.slice(providerEnd) + search };
}

function declaresBody(headers: Headers): boolean {
  const length = headers.get("content-length");
  return headers.has("transfer-encoding") || (length !== null && length !== "0");
}

async function readBody(request: Request): Promise<string> {
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Refusal("invalid_request");
    }
    chunks.push(value);
  }
  // The string is what gets matched, signed and sent, so the bytes must decode without loss.
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  try {
    return decoder.decode(Buffer.concat(chunks));
  } catch {
    throw new Refusal("invalid_request");
  }
}

async function authHeaders<Provider extends SafeProxyProvider>(
  loadCredential: CredentialLoader,
  provider: Provider,
  credentialHeader: string | undefined,
  request: InjectionRequest
): Promise<AuthHeaders> {
  const reference = credentialReferenceSchema.safeParse(credentialHeader);
  if (!reference.success) throw new Refusal("invalid_request");
  const credential = await loadCredential(provider, reference.data);
  return AUTH_BY_PROVIDER[provider](credential, request);
}

export function createForwardHandler(
  dependencies: ForwardDependencies
): (c: Context<AppEnv>) => Promise<Response> {
  return async (c) => {
    const caller = await dependencies.identifyCaller(c.req.raw.headers);
    c.set("progress", { stage: "identified", caller });

    if (c.get("requestId") === null) throw new Refusal("invalid_request");
    const budgetMs = readBudgetMs(c.req.header(FORWARD_HEADERS.budgetMs), dependencies.maxBudgetMs);
    const deadline = c.get("receivedAt") + budgetMs;

    const { provider: requestedProvider, target } = providerRequest(c.req.url);
    const body = await readBody(c.req.raw);
    const match = matchEndpoint({
      provider: requestedProvider,
      method: c.req.method,
      path: target,
      body,
    });
    if (!match.allowed) throw new Refusal(match.code);
    const { provider, endpoint } = match;
    const matched = { stage: "matched", caller, provider, endpoint } as const;
    c.set("progress", { ...matched, providerCall: "not_sent" });

    if (!endpoint.callers.includes(caller.caller)) throw new Refusal("caller_not_allowed");
    // A request object may not expose the body of a GET, so its headers are checked too.
    if (!CARRIES_BODY[endpoint.method] && (body !== "" || declaresBody(c.req.raw.headers))) {
      throw new Refusal("body_not_allowed");
    }

    const auth = await authHeaders(
      dependencies.loadCredential,
      provider,
      c.req.header(FORWARD_HEADERS.credential),
      { path: target, body }
    );

    // Only what the endpoint declares is passed through; the auth is set last.
    const headers = new Headers();
    for (const name of endpoint.requestHeaders) {
      const value = c.req.header(name);
      if (value !== undefined) headers.set(name, value);
    }
    if (body !== "") headers.set("content-type", "application/json");
    for (const [name, value] of Object.entries(auth)) headers.set(name, value);

    const remainingMs = deadline - dependencies.now();
    if (remainingMs <= 0) throw new Refusal("deadline_exceeded");
    const budget = new AbortController();
    const budgetTimer = setTimeout(() => budget.abort(), remainingMs);

    const [host] = PROVIDER_HOSTS[provider];
    c.set("progress", { ...matched, providerCall: "in_flight" });
    let answer: Response;
    let answerBody: ArrayBuffer;
    try {
      answer = await dependencies.fetch(`https://${host}${target}`, {
        method: endpoint.method,
        headers,
        body: body === "" ? null : body,
        redirect: "manual",
        signal: budget.signal,
      });
      answerBody = await answer.arrayBuffer();
    } finally {
      clearTimeout(budgetTimer);
    }
    c.set("progress", { ...matched, providerCall: "answered" });

    const answerHeaders = new Headers({ [FORWARD_HEADERS.result]: "forwarded" });
    const contentType = answer.headers.get("content-type");
    if (contentType !== null) answerHeaders.set("content-type", contentType);
    return new Response(answerBody.byteLength === 0 ? null : answerBody, {
      status: answer.status,
      headers: answerHeaders,
    });
  };
}
