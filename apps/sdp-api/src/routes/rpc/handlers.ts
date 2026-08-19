import {
  listRpcProviders,
  type ResolvedRpcTarget,
  recordRpcRelayTelemetry,
  resolveRoundRobinRpcTargets,
  resolveRpcTarget,
} from "@sdp/rpc/relay";
import type { Context } from "hono";
import { z } from "zod";
import { getDb } from "@/db";
import { getAuth } from "@/lib/auth";
import { AppError, badRequestQuery } from "@/lib/errors";
import { success } from "@/lib/response";
import type { ValidatedBodyContext } from "@/middleware/validate";
import {
  checkResolvedRpcTargetConnection,
  getProviderSetupDefinition,
} from "@/services/provider-setup-registry";
import { createTenantRpcConnectionLookup } from "@/services/rpc-connection-lookup";
import type { Env } from "@/types/env";
import { rpcProjectQuerySchema, type rpcRelayPayloadSchema } from "./schemas";

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

  await recordRpcRelayTelemetry(c.var.kv.cache, {
    providerId: target.providerId,
    connectionId: target.connectionId,
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
    throw badRequestQuery({
      errors: z.flattenError(queryParse.error).fieldErrors,
    });
  }

  const response = await listRpcProviders({
    env: c.env,
    kv: c.var.kv,
    db: getDb(c.env),
    organizationId: auth.organizationId,
    authProjectId: auth.projectId,
    requestedProjectId: queryParse.data.projectId ?? null,
    connections: createTenantRpcConnectionLookup(c.env, getDb(c.env)),
  });

  return success(c, response);
};

export const relayRpcRequest = async (c: ValidatedBodyContext<typeof rpcRelayPayloadSchema>) => {
  const auth = getAuth(c);
  const queryParse = rpcProjectQuerySchema.safeParse(c.req.query());

  if (!queryParse.success) {
    throw badRequestQuery({
      errors: z.flattenError(queryParse.error).fieldErrors,
    });
  }

  const payload = c.req.valid("json");

  const methodNames = extractRpcMethodNames(payload);

  if (shouldRoundRobinFaucetRequest(payload, methodNames)) {
    const targets = await resolveRoundRobinRpcTargets({
      env: c.env,
      kv: c.var.kv,
      db: getDb(c.env),
      organizationId: auth.organizationId,
      authProjectId: auth.projectId,
      requestedProjectId: queryParse.data.projectId ?? null,
      connections: createTenantRpcConnectionLookup(c.env, getDb(c.env)),
    });

    let lastResponse: ReturnType<typeof buildRelayResponse> | null = null;
    let lastError: unknown = null;

    for (const target of targets) {
      const startedAt = Date.now();
      try {
        const { upstream, upstreamBody } = await relayToTarget(c, target, payload, methodNames, {
          recordJsonRpcErrorAsFailure: true,
        });
        const relayResponse = buildRelayResponse(target, upstream, upstreamBody, methodNames);
        if (upstream.ok && !isJsonRpcErrorResponse(upstreamBody)) {
          return success(c, relayResponse);
        }
        lastResponse = relayResponse;
      } catch (error) {
        lastError = error;
        await recordRpcRelayTelemetry(c.var.kv.cache, {
          providerId: target.providerId,
          connectionId: target.connectionId,
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
    kv: c.var.kv,
    db: getDb(c.env),
    organizationId: auth.organizationId,
    authProjectId: auth.projectId,
    requestedProjectId: queryParse.data.projectId ?? null,
    connections: createTenantRpcConnectionLookup(c.env, getDb(c.env)),
  });

  const startedAt = Date.now();
  try {
    const { upstream, upstreamBody } = await relayToTarget(c, target, payload, methodNames);
    return success(c, buildRelayResponse(target, upstream, upstreamBody, methodNames));
  } catch (error) {
    await recordRpcRelayTelemetry(c.var.kv.cache, {
      providerId: target.providerId,
      connectionId: target.connectionId,
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
    throw badRequestQuery({
      errors: z.flattenError(queryParse.error).fieldErrors,
    });
  }

  const methodNames = ["getVersion"];
  const target = await resolveRpcTarget({
    env: c.env,
    kv: c.var.kv,
    db: getDb(c.env),
    organizationId: auth.organizationId,
    authProjectId: auth.projectId,
    requestedProjectId: queryParse.data.projectId ?? null,
    connections: createTenantRpcConnectionLookup(c.env, getDb(c.env)),
  });

  const startedAt = Date.now();
  try {
    const { upstream, upstreamBody, elapsedMs } =
      target.providerId === "custom"
        ? await checkResolvedRpcTargetConnection({ target })
        : await getProviderSetupDefinition("rpc", target.providerId).checkConnection({ target });

    await recordRpcRelayTelemetry(c.var.kv.cache, {
      providerId: target.providerId,
      connectionId: target.connectionId,
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
    await recordRpcRelayTelemetry(c.var.kv.cache, {
      providerId: target.providerId,
      connectionId: target.connectionId,
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
