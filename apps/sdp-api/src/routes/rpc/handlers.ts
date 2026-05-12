import type { Context } from "hono";
import { getDb } from "@/db";
import { getAuth } from "@/lib/auth";
import { AppError } from "@/lib/errors";
import { success } from "@/lib/response";
import {
  listRpcProviders,
  type ResolvedRpcTarget,
  recordRpcRelayTelemetry,
  resolveRoundRobinRpcTargets,
  resolveRpcTarget,
} from "@/services/rpc-relay.service";
import type { Env } from "@/types/env";
import { rpcProjectQuerySchema, rpcRelayPayloadSchema } from "./schemas";

type AppContext = Context<{ Bindings: Env }>;

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

function getTelemetryOrigin(c: AppContext): string | null {
  return (
    c.req.header("Origin") ?? c.req.header("X-Forwarded-Host") ?? c.req.header("User-Agent") ?? null
  );
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

async function relayToTarget(
  c: AppContext,
  target: ResolvedRpcTarget,
  payload: unknown,
  methodNames: string[],
  options: { recordJsonRpcErrorAsFailure?: boolean } = {}
) {
  const startedAt = Date.now();
  const headers = {
    "Content-Type": "application/json",
    ...target.headers,
  };

  const upstream = await fetch(target.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  const rawBody = await upstream.text();
  const upstreamBody = rawBody ? tryParseJson(rawBody) : null;
  const elapsedMs = Date.now() - startedAt;

  await recordRpcRelayTelemetry(c.env.SDP_CACHE!, {
    providerId: target.providerId,
    methodNames,
    statusCode: upstream.status,
    latencyMs: elapsedMs,
    ok:
      upstream.ok &&
      (!options.recordJsonRpcErrorAsFailure || !isJsonRpcErrorResponse(upstreamBody)),
    origin: getTelemetryOrigin(c),
  });

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
      selectionMode: target.selectionMode,
      projectId: target.projectId,
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

export const getRpcProviders = async (c: AppContext) => {
  const auth = getAuth(c);
  const queryParse = rpcProjectQuerySchema.safeParse(c.req.query());

  if (!queryParse.success) {
    throw new AppError("BAD_REQUEST", "Invalid query parameters", {
      errors: queryParse.error.flatten().fieldErrors,
    });
  }

  const response = await listRpcProviders({
    env: c.env,
    db: getDb(c.env),
    organizationId: auth.organizationId,
    authProjectId: auth.projectId,
    requestedProjectId: queryParse.data.projectId ?? null,
  });

  return success(c, response);
};

export const relayRpcRequest = async (c: AppContext) => {
  const auth = getAuth(c);
  const queryParse = rpcProjectQuerySchema.safeParse(c.req.query());

  if (!queryParse.success) {
    throw new AppError("BAD_REQUEST", "Invalid query parameters", {
      errors: queryParse.error.flatten().fieldErrors,
    });
  }

  let requestBody: unknown;
  try {
    requestBody = await c.req.json();
  } catch {
    throw new AppError("BAD_REQUEST", "Invalid JSON body");
  }

  const payloadParse = rpcRelayPayloadSchema.safeParse(requestBody);
  if (!payloadParse.success) {
    throw new AppError("BAD_REQUEST", "Invalid JSON-RPC payload", {
      errors: payloadParse.error.flatten().fieldErrors,
    });
  }

  const methodNames = extractRpcMethodNames(payloadParse.data);

  if (shouldRoundRobinFaucetRequest(payloadParse.data, methodNames)) {
    const targets = await resolveRoundRobinRpcTargets({
      env: c.env,
      db: getDb(c.env),
      organizationId: auth.organizationId,
      authProjectId: auth.projectId,
      requestedProjectId: queryParse.data.projectId ?? null,
    });

    let lastResponse: ReturnType<typeof buildRelayResponse> | null = null;
    let lastError: unknown = null;

    for (const target of targets) {
      const startedAt = Date.now();
      try {
        const { upstream, upstreamBody } = await relayToTarget(
          c,
          target,
          payloadParse.data,
          methodNames,
          { recordJsonRpcErrorAsFailure: true }
        );
        const relayResponse = buildRelayResponse(target, upstream, upstreamBody, methodNames);
        if (upstream.ok && !isJsonRpcErrorResponse(upstreamBody)) {
          return success(c, relayResponse);
        }
        lastResponse = relayResponse;
      } catch (error) {
        lastError = error;
        await recordRpcRelayTelemetry(c.env.SDP_CACHE!, {
          providerId: target.providerId,
          methodNames,
          statusCode: 0,
          latencyMs: Date.now() - startedAt,
          ok: false,
          origin: getTelemetryOrigin(c),
        }).catch(() => {});
      }
    }

    if (lastResponse) {
      return success(c, lastResponse);
    }

    throw new AppError(
      "SOLANA_RPC_ERROR",
      lastError instanceof Error ? lastError.message : "RPC relay request failed"
    );
  }

  const target = await resolveRpcTarget({
    env: c.env,
    db: getDb(c.env),
    organizationId: auth.organizationId,
    authProjectId: auth.projectId,
    requestedProjectId: queryParse.data.projectId ?? null,
  });

  const startedAt = Date.now();
  try {
    const { upstream, upstreamBody } = await relayToTarget(
      c,
      target,
      payloadParse.data,
      methodNames
    );
    return success(c, buildRelayResponse(target, upstream, upstreamBody, methodNames));
  } catch (error) {
    await recordRpcRelayTelemetry(c.env.SDP_CACHE!, {
      providerId: target.providerId,
      methodNames,
      statusCode: 0,
      latencyMs: Date.now() - startedAt,
      ok: false,
      origin: getTelemetryOrigin(c),
    }).catch(() => {});

    throw new AppError(
      "SOLANA_RPC_ERROR",
      error instanceof Error ? error.message : "RPC relay request failed"
    );
  }
};

export const testRpcConnection = async (c: AppContext) => {
  const auth = getAuth(c);
  const queryParse = rpcProjectQuerySchema.safeParse(c.req.query());

  if (!queryParse.success) {
    throw new AppError("BAD_REQUEST", "Invalid query parameters", {
      errors: queryParse.error.flatten().fieldErrors,
    });
  }

  const methodNames = ["getVersion"];
  const target = await resolveRpcTarget({
    env: c.env,
    db: getDb(c.env),
    organizationId: auth.organizationId,
    authProjectId: auth.projectId,
    requestedProjectId: queryParse.data.projectId ?? null,
  });

  const startedAt = Date.now();
  const headers = {
    "Content-Type": "application/json",
    ...target.headers,
  };

  try {
    const upstream = await fetch(target.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "rpc-connectivity-test",
        method: "getVersion",
        params: [],
      }),
    });

    const rawBody = await upstream.text();
    const upstreamBody = rawBody ? tryParseJson(rawBody) : null;
    const elapsedMs = Date.now() - startedAt;

    await recordRpcRelayTelemetry(c.env.SDP_CACHE!, {
      providerId: target.providerId,
      methodNames,
      statusCode: upstream.status,
      latencyMs: elapsedMs,
      ok: upstream.ok,
      origin: getTelemetryOrigin(c),
    });

    return success(c, {
      provider: {
        id: target.providerId,
        selectionMode: target.selectionMode,
        projectId: target.projectId,
        endpoint: target.endpointLabel,
      },
      upstream: {
        ok: upstream.ok,
        status: upstream.status,
        statusText: upstream.statusText,
      },
      methods: methodNames,
      response: upstreamBody,
    });
  } catch (error) {
    await recordRpcRelayTelemetry(c.env.SDP_CACHE!, {
      providerId: target.providerId,
      methodNames,
      statusCode: 0,
      latencyMs: Date.now() - startedAt,
      ok: false,
      origin: getTelemetryOrigin(c),
    }).catch(() => {});

    throw new AppError(
      "SOLANA_RPC_ERROR",
      error instanceof Error ? error.message : "RPC connectivity test failed"
    );
  }
};
