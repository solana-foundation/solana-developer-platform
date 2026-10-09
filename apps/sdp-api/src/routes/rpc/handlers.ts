import {
  type ResolvedRpcTarget,
  resolveRoundRobinRpcTargets,
  resolveRpcTarget,
} from "@sdp/rpc/relay";
import { getDb } from "@/db";
import { getAuth } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { success } from "@/lib/response";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { assertFaucetDestinationsOwned } from "@/services/faucet-destination-guard";
import type { rpcRelayPayloadSchema } from "./schemas";

/** A stalled managed upstream must not hold the request open indefinitely. */
const RELAY_TIMEOUT_MS = 30_000;

function extractRpcMethodNames(payload: unknown): string[] {
  if (Array.isArray(payload)) {
    return payload.map((item) => (item as { method?: string }).method).filter(Boolean) as string[];
  }
  const method = (payload as { method?: string }).method;
  return method ? [method] : [];
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function isJsonRpcErrorResponse(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => isJsonRpcErrorResponse(entry));
  }

  return Boolean(value && typeof value === "object" && "error" in value);
}

function shouldRoundRobinFaucetRequest(payload: unknown, methodNames: string[]): boolean {
  return !Array.isArray(payload) && methodNames.length === 1 && methodNames[0] === "requestAirdrop";
}

/**
 * POST a JSON-RPC payload to a managed provider, bounded by the relay timeout.
 *
 * @param target - The managed provider to send to.
 * @param payload - The validated JSON-RPC request or batch.
 * @returns The upstream response and its body, parsed as JSON when it is JSON.
 */
async function relayToTarget(target: ResolvedRpcTarget, payload: unknown) {
  const upstream = await fetch(target.endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
  });

  const rawBody = await upstream.text();
  const upstreamBody = rawBody ? tryParseJson(rawBody) : null;

  return { upstream, upstreamBody };
}

function buildRelayResponse(
  target: ResolvedRpcTarget,
  upstream: Response,
  upstreamBody: unknown,
  methodNames: string[]
) {
  return {
    provider: {
      id: target.providerId,
      endpoint: target.endpointLabel,
    },
    upstream: {
      ok: upstream.ok,
      status: upstream.status,
      statusText: upstream.statusText,
    },
    methods: methodNames,
    response: upstreamBody,
  };
}

// `AbortSignal.timeout` rejects with a DOMException, which Node does not put
// on Error's prototype chain — matched by name, not instanceof.
function isTimeoutError(error: unknown): boolean {
  const name = error && typeof error === "object" ? (error as { name?: unknown }).name : null;
  return name === "TimeoutError" || name === "AbortError";
}

// The caller can safely resend the same signed bytes on a timeout, but only
// if it can tell "the upstream never answered" apart from "the upstream said
// no" — hence distinct codes instead of one generic relay error.
function toRelayError(error: unknown): AppError {
  if (isTimeoutError(error)) {
    return new AppError("SOLANA_RPC_TIMEOUT");
  }
  return new AppError(
    "SOLANA_RPC_ERROR",
    error instanceof Error ? error.message : "RPC relay request failed"
  );
}

export const relayRpcRequest = async (c: ValidatedBodyContext<typeof rpcRelayPayloadSchema>) => {
  const auth = getAuth(c);
  const payload = c.req.valid("json");

  const methodNames = extractRpcMethodNames(payload);

  // Before EITHER dispatch branch: a `requestAirdrop` inside a JSON-RPC batch
  // array skips the faucet branch below, so a check living only there would be
  // bypassed by wrapping the call in an array.
  await assertFaucetDestinationsOwned(getDb(c.env), auth.organizationId, payload);

  if (shouldRoundRobinFaucetRequest(payload, methodNames)) {
    const targets = await resolveRoundRobinRpcTargets({ env: c.env, cache: c.var.kv.cache });

    let lastResponse: ReturnType<typeof buildRelayResponse> | null = null;
    let lastError: unknown = null;

    for (const target of targets) {
      try {
        const { upstream, upstreamBody } = await relayToTarget(target, payload);
        const relayResponse = buildRelayResponse(target, upstream, upstreamBody, methodNames);
        if (upstream.ok && !isJsonRpcErrorResponse(upstreamBody)) {
          return success(c, relayResponse);
        }
        lastResponse = relayResponse;
      } catch (error) {
        lastError = error;
      }
    }

    if (lastResponse) {
      return success(c, lastResponse);
    }

    throw toRelayError(lastError);
  }

  const target = await resolveRpcTarget({ env: c.env, cache: c.var.kv.cache });

  try {
    const { upstream, upstreamBody } = await relayToTarget(target, payload);
    return success(c, buildRelayResponse(target, upstream, upstreamBody, methodNames));
  } catch (error) {
    throw toRelayError(error);
  }
};
