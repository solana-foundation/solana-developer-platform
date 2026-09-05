import { createRingsGateway, probeRingRpcHealth } from "@sdp/helius-rings-sdk";
import { assertReachableTenantEndpoint } from "@sdp/rpc/byok";
import type { Context } from "hono";
import { getDb } from "@/db";
import { parsePostgresJsonOr } from "@/db/postgres-utils";
import { getAuth, requireProjectId } from "@/lib/auth";
import { badRequest, conflict, forbidden, notFound } from "@/lib/errors";
import {
  createCredentialSecretStore,
  type StoredCredentialSecret,
} from "@/services/credential-secret-store";
import {
  type HeliusRingsConnectionRow,
  HeliusRingsConnectionStore,
} from "@/services/stores/helius-rings-connection.store";
import { ProviderCredentialStore } from "@/services/stores/provider-credential.store";
import type { Env } from "@/types/env";
import { resolveRingsConnection } from "./connection-resolver";

type AppContext = Context<{ Bindings: Env }>;

export interface RingsConnectionInput {
  name: string;
  solanaRpcUrl: string;
  indexerUrl: string;
  proverUrl: string;
  ringRpcUrl?: string;
  allowInsecureHttp: boolean;
}

export interface SafeRingsConnection {
  id: string;
  name: string;
  network: "devnet";
  status: HeliusRingsConnectionRow["status"];
  isDefault: boolean;
  allowInsecureHttp: boolean;
  endpoints: {
    rpc: string | null;
    indexer: string | null;
    prover: string | null;
    ringRpc: string | null;
  };
  lastCheckStatus: string | null;
  lastCheckAt: string | null;
  lastCheckFailureCode: string | null;
  createdAt: string;
}

interface DisplayMetadata {
  rpcOrigin?: string;
  indexerOrigin?: string;
  proverOrigin?: string;
  ringRpcOrigin?: string;
}

export function mapRingsConnection(row: HeliusRingsConnectionRow): SafeRingsConnection {
  const metadata = parsePostgresJsonOr<DisplayMetadata>(row.display_metadata, {});
  return {
    id: row.id,
    name: row.name,
    network: row.network,
    status: row.status,
    isDefault: row.is_default,
    allowInsecureHttp: row.allow_insecure_http,
    endpoints: {
      rpc: metadata.rpcOrigin ?? null,
      indexer: metadata.indexerOrigin ?? null,
      prover: metadata.proverOrigin ?? null,
      ringRpc: metadata.ringRpcOrigin ?? null,
    },
    lastCheckStatus: row.last_check_status,
    lastCheckAt: row.last_check_at,
    lastCheckFailureCode: row.last_check_failure_code,
    createdAt: row.created_at,
  };
}

export async function getRingsSetupStatus(c: AppContext) {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const canManage =
    auth.authType !== "api_key" &&
    (auth.permissions.includes("org:admin") || auth.permissions.includes("*"));
  const allowInsecureHttpAllowed = c.env.ENVIRONMENT === "development";
  const rows = await new HeliusRingsConnectionStore(getDb(c.env)).list(
    auth.organizationId,
    projectId
  );
  const activeDefault = rows.find((row) => row.status === "active" && row.is_default);
  if (activeDefault) {
    return {
      configured: true,
      source: "database" as const,
      canManage,
      allowInsecureHttpAllowed,
      defaultConnection: mapRingsConnection(activeDefault),
    };
  }

  return {
    configured: false,
    source: "none" as const,
    canManage,
    allowInsecureHttpAllowed,
    defaultConnection: null,
  };
}

export async function listRingsConnections(c: AppContext) {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const rows = await new HeliusRingsConnectionStore(getDb(c.env)).list(
    auth.organizationId,
    projectId
  );
  return { connections: rows.map(mapRingsConnection) };
}

export async function createRingsConnection(
  c: AppContext,
  input: RingsConnectionInput
): Promise<SafeRingsConnection> {
  const auth = getAuth(c);
  if (!auth.userId) throw forbidden("Rings connection management requires an administrator");
  const projectId = requireProjectId(c);
  const normalized = validateRingsConnectionInput(c.env, input);

  const [health, ringRpcHealth] = await Promise.all([
    createRingsGateway({
      solanaRpcUrl: normalized.solanaRpcUrl,
      indexerUrl: normalized.indexerUrl,
      proverUrl: normalized.proverUrl,
      organizationId: auth.organizationId,
      projectId,
      allowInsecureHttp: normalized.allowInsecureHttp,
      signTransaction: async () => {
        throw new Error("probe does not sign");
      },
      submitTransaction: async () => {
        throw new Error("probe does not submit");
      },
    }).probeHealth(),
    normalized.ringRpcUrl
      ? probeRingRpcHealth({ url: normalized.ringRpcUrl })
      : Promise.resolve(null),
  ]);
  const failed: string[] = (["rpc", "photon", "prover"] as const).filter(
    (component) => health[component] === "red"
  );
  if (ringRpcHealth?.status === "red") failed.push("ringRpc");
  if (failed.length > 0) {
    throw conflict("Helius Rings rejected the connection", {
      components: failed,
    });
  }

  const db = getDb(c.env);
  const connectionStore = new HeliusRingsConnectionStore(db);
  const makeDefault = (await connectionStore.countActive(auth.organizationId, projectId)) === 0;
  const providerCredentialId = `pcred_${crypto.randomUUID()}`;
  const connectionId = `hrconn_${crypto.randomUUID()}`;
  const displayMetadata = displayMetadataFor(normalized);
  const secretStore = createCredentialSecretStore(c.env);
  const stored = await secretStore.write({
    orgId: auth.organizationId,
    provider: "helius_rings",
    providerCredentialId,
    payload: {
      solanaRpcUrl: normalized.solanaRpcUrl,
      indexerUrl: normalized.indexerUrl,
      proverUrl: normalized.proverUrl,
      ...(normalized.ringRpcUrl ? { ringRpcUrl: normalized.ringRpcUrl } : {}),
    },
  });

  try {
    return await db.transaction(async (tx) => {
      const credential = await new ProviderCredentialStore(tx).insertCredential({
        id: providerCredentialId,
        organizationId: auth.organizationId,
        projectId,
        provider: "helius_rings",
        label: normalized.name,
        scope: "project",
        source: "stored",
        stored,
        displayMetadata: compactMetadata(displayMetadata),
        version: 1,
        rotatedFromId: null,
        idempotencyKey: connectionId,
        idempotencyFingerprint: connectionId,
        createdBy: auth.userId,
      });
      await tx.execute(
        `UPDATE provider_credentials
            SET status = 'active', last_validated_at = sdp_iso_now(), updated_at = sdp_iso_now()
          WHERE id = ?`,
        [credential.id]
      );
      const row = await new HeliusRingsConnectionStore(tx).insert({
        id: connectionId,
        organizationId: auth.organizationId,
        projectId,
        name: normalized.name,
        providerCredentialId,
        providerCredentialScopeKey: credential.scope_key,
        allowInsecureHttp: normalized.allowInsecureHttp,
        displayMetadata,
        makeDefault,
        createdBy: auth.userId,
      });
      return mapRingsConnection(row);
    });
  } catch (error) {
    await destroyStoredVersion(secretStore, stored);
    throw error;
  }
}

export async function makeDefaultRingsConnection(c: AppContext, connectionId: string) {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const db = getDb(c.env);
  const row = await db.transaction((tx) =>
    new HeliusRingsConnectionStore(tx).makeDefault(auth.organizationId, projectId, connectionId)
  );
  if (!row) throw notFound("Helius Rings connection");
  return mapRingsConnection(row);
}

export async function deactivateRingsConnection(c: AppContext, connectionId: string) {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const db = getDb(c.env);
  const store = new HeliusRingsConnectionStore(db);
  const rows = await store.list(auth.organizationId, projectId);
  const target = rows.find((row) => row.id === connectionId);
  if (!target) throw notFound("Helius Rings connection");
  if (target.is_default)
    throw conflict("Choose another default connection before deactivating this one");
  const row = await db.transaction(async (tx) => {
    const transactionalStore = new HeliusRingsConnectionStore(tx);
    const locked = await transactionalStore.lockActiveNonDefault(
      auth.organizationId,
      projectId,
      connectionId
    );
    if (!locked) return null;
    if (
      await transactionalStore.hasUnsettledOperations(auth.organizationId, projectId, connectionId)
    ) {
      throw conflict("Settle or void operations pinned to this connection before deactivating it");
    }
    const deactivated = await transactionalStore.deactivate(
      auth.organizationId,
      projectId,
      connectionId
    );
    if (!deactivated) return null;
    await tx.execute(
      `UPDATE provider_credentials
          SET status = 'deactivated', updated_at = sdp_iso_now()
        WHERE id = ? AND organization_id = ?`,
      [deactivated.provider_credential_id, auth.organizationId]
    );
    return deactivated;
  });
  if (!row) throw conflict("Choose another default connection before deactivating this one");
  return mapRingsConnection(row);
}

export async function testRingsConnection(c: AppContext, connectionId: string) {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const connection = await resolveRingsConnection({
    env: c.env,
    organizationId: auth.organizationId,
    projectId,
    connectionId,
  });
  const [health, ringRpc] = await Promise.all([
    createRingsGateway({
      ...connection,
      organizationId: auth.organizationId,
      projectId,
      signTransaction: async () => {
        throw new Error("probe does not sign");
      },
      submitTransaction: async () => {
        throw new Error("probe does not submit");
      },
    }).probeHealth(),
    connection.ringRpcUrl
      ? probeRingRpcHealth({ url: connection.ringRpcUrl })
      : Promise.resolve(null),
  ]);
  return { health, ringRpc };
}

export function validateRingsConnectionInput(
  env: Env,
  input: RingsConnectionInput
): RingsConnectionInput {
  const allowInsecureHttp = input.allowInsecureHttp;
  if (allowInsecureHttp && env.ENVIRONMENT !== "development") {
    throw badRequest("Plain HTTP Rings endpoints are allowed only in development");
  }
  const normalized = {
    name: input.name.trim(),
    solanaRpcUrl: validateUrl(input.solanaRpcUrl, "Solana RPC", allowInsecureHttp),
    indexerUrl: validateUrl(input.indexerUrl, "Photon indexer", allowInsecureHttp),
    proverUrl: validateUrl(input.proverUrl, "prover", allowInsecureHttp),
    ringRpcUrl: input.ringRpcUrl
      ? validateUrl(input.ringRpcUrl, "custom Ring RPC", allowInsecureHttp)
      : undefined,
    allowInsecureHttp,
  };
  if (!normalized.name || normalized.name.length > 100) {
    throw badRequest("Connection name must contain between 1 and 100 characters");
  }
  return normalized;
}

function validateUrl(value: string, label: string, allowInsecureHttp: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw badRequest(`${label} URL is invalid`);
  }
  if (parsed.protocol !== "https:" && !(allowInsecureHttp && parsed.protocol === "http:")) {
    throw badRequest(`${label} URL must use HTTPS`);
  }
  if (parsed.username || parsed.password) throw badRequest(`${label} URL cannot contain user info`);
  try {
    // Development may relax the scheme, never the host policy.
    const policyUrl = new URL(parsed);
    policyUrl.protocol = "https:";
    assertReachableTenantEndpoint(policyUrl.toString());
  } catch {
    throw badRequest(`${label} URL points to a host SDP cannot reach`);
  }
  return parsed.toString();
}

function displayMetadataFor(input: RingsConnectionInput) {
  return {
    rpcOrigin: new URL(input.solanaRpcUrl).origin,
    indexerOrigin: new URL(input.indexerUrl).origin,
    proverOrigin: new URL(input.proverUrl).origin,
    ringRpcOrigin: input.ringRpcUrl ? new URL(input.ringRpcUrl).origin : null,
  };
}

function compactMetadata(metadata: ReturnType<typeof displayMetadataFor>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata).filter((entry): entry is [string, string] => entry[1] !== null)
  );
}

async function destroyStoredVersion(
  store: ReturnType<typeof createCredentialSecretStore>,
  stored: StoredCredentialSecret
) {
  if (stored.secretVersionRef) {
    await store.destroyVersion({ secretVersionRef: stored.secretVersionRef }).catch(() => {});
  }
}
