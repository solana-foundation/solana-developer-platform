import {
  assertReachableTenantEndpoint,
  type ByokRpcProvider,
  buildTenantDisplayMetadata,
  buildTenantRpcTarget,
  resolveTenantEndpoint,
  type TenantRpcCredential,
} from "@sdp/rpc/byok";
import type { RpcConnectionNetwork, SafeRpcConnection } from "@sdp/types";
import type { Context } from "hono";
import { getDb } from "@/db";
import { parsePostgresJsonOr } from "@/db/postgres-utils";
import { getAuth } from "@/lib/auth";
import { badRequest, conflict, forbidden, notFound } from "@/lib/errors";
import {
  type CredentialSecretStorageBackend,
  createCredentialSecretStore,
} from "@/services/credential-secret-store";
import { probeRpcEndpoint, toRedactedFailureCode } from "@/services/rpc-probe";
import { ProviderCredentialStore } from "@/services/stores/provider-credential.store";
import {
  ORGANIZATION_SCOPE_KEY,
  type RpcConnectionListRow,
  type RpcConnectionRow,
  RpcConnectionStore,
} from "@/services/stores/rpc-connection.store";
import type { Env } from "@/types/env";

type AppContext = Context<{ Bindings: Env }>;

export interface SubmitRpcConnectionInput {
  provider: ByokRpcProvider;
  network: RpcConnectionNetwork;
  scope: "organization" | "project";
  credentialLabel: string;
  /** Omitted for providers whose endpoint is the same for every account. */
  endpointUrl?: string;
  apiKey: string;
}

/**
 * The mapper is the redaction boundary. It reads only the columns
 * `SafeRpcConnection` declares, so a secret ref added to the row type later
 * cannot ride out through here by accident.
 */
export function mapRpcConnection(row: RpcConnectionListRow): SafeRpcConnection {
  return {
    id: row.id,
    provider: row.provider as SafeRpcConnection["provider"],
    scope: row.scope,
    projectId: row.project_id,
    network: row.network,
    status: row.status,
    isDefault: row.is_default,
    displayMetadata: parsePostgresJsonOr<Record<string, unknown>>(row.display_metadata, {}),
    lastCheck: row.last_check_status
      ? {
          status: row.last_check_status,
          at: row.last_check_at,
          failureCode: row.last_check_failure_code,
        }
      : null,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
    deactivatedAt: row.deactivated_at,
    providerCredential: {
      id: row.credential_id,
      label: row.credential_label,
      status: row.credential_status,
    },
  };
}

function resolveScope(
  c: AppContext,
  scope: "organization" | "project"
): { projectId: string | null; scopeKey: string } {
  if (scope === "organization") {
    return { projectId: null, scopeKey: ORGANIZATION_SCOPE_KEY };
  }

  const projectId = c.get("projectId");
  if (!projectId) {
    throw badRequest("A project-scoped RPC connection requires a selected project");
  }
  return { projectId, scopeKey: projectId };
}

/**
 * The scopes this request may act on: the organization plus whichever project
 * is selected, never another project's. The selected project is already
 * membership-checked by middleware, so anchoring to it is what stops one
 * project's administrator naming another project's connection by id.
 *
 * The organization key stays in the set on purpose. These routes gate on
 * `org:admin`, which is organization-wide rather than per-project, so a
 * project context is an additional grant and not a restriction — and
 * `projectContextMiddleware` requires `x-project-id` on every request, so
 * narrowing to the project alone would make organization-scoped connections,
 * which is what POST /connections creates by default, impossible to activate,
 * deactivate or make default.
 */
function actingScopeKeys(c: AppContext): string[] {
  const projectId = c.get("projectId");
  return projectId ? [ORGANIZATION_SCOPE_KEY, projectId] : [ORGANIZATION_SCOPE_KEY];
}

function requireUserId(c: AppContext): string {
  const auth = getAuth(c);
  const userId = auth.userId;
  if (!userId) {
    // The route middleware already refuses API keys; this is the type-level
    // half of the same rule.
    throw forbidden("RPC connection management requires a signed-in administrator");
  }
  return userId;
}

export async function listRpcConnections(
  c: AppContext,
  options: { limit: number; offset: number; scope: "organization" | "project" }
) {
  const auth = getAuth(c);
  const { scopeKey } = resolveScope(c, options.scope);
  const store = new RpcConnectionStore(getDb(c.env));
  const { connections, total } = await store.listConnectionsPage(auth.organizationId, scopeKey, {
    limit: options.limit,
    offset: options.offset,
  });

  return {
    connections: connections.map(mapRpcConnection),
    pagination: { limit: options.limit, offset: options.offset, total },
  };
}

/**
 * Create a tenant-owned connection.
 *
 * Ordering is the whole point: the secret is written first, then the credential
 * and connection rows go in together inside one transaction. A failed secret
 * write leaves no rows at all, and a failed transaction destroys the secret
 * version it already wrote, so neither half can outlive the other.
 */
export async function submitRpcConnection(
  c: AppContext,
  input: SubmitRpcConnectionInput
): Promise<SafeRpcConnection> {
  const auth = getAuth(c);
  const userId = requireUserId(c);
  const { projectId, scopeKey } = resolveScope(c, input.scope);

  const credential: TenantRpcCredential = {
    // A tenant only types an endpoint when their account has its own; for the
    // rest the provider's published host is used.
    endpointUrl: resolveTenantEndpoint(input.provider, input.network, input.endpointUrl),
    apiKey: input.apiKey,
  };

  // Reject an endpoint we cannot build a target from, or must never reach,
  // before anything is written -- no secret stored for a connection that can
  // never run, and no row that would point the relay at a private address.
  assertReachableTenantEndpoint(credential.endpointUrl);
  buildTenantRpcTarget(input.provider, credential);

  const providerCredentialId = `pcred_${crypto.randomUUID()}`;
  const connectionId = `rconn_${crypto.randomUUID()}`;

  const secretStore = createCredentialSecretStore(c.env);
  const stored = await secretStore.write({
    orgId: auth.organizationId,
    provider: input.provider,
    providerCredentialId,
    payload: { endpointUrl: credential.endpointUrl, apiKey: input.apiKey },
  });

  const db = getDb(c.env);
  try {
    return await db.transaction(async (tx) => {
      const credentialStore = new ProviderCredentialStore(tx);
      const connectionStore = new RpcConnectionStore(tx);

      const providerCredential = await credentialStore.insertCredential({
        id: providerCredentialId,
        organizationId: auth.organizationId,
        projectId,
        provider: input.provider,
        label: input.credentialLabel,
        scope: input.scope,
        source: "stored",
        stored,
        displayMetadata: buildTenantDisplayMetadata(credential),
        version: 1,
        rotatedFromId: null,
        idempotencyKey: connectionId,
        idempotencyFingerprint: connectionId,
        createdBy: userId,
      });

      const connection = await connectionStore.insertConnection({
        id: connectionId,
        organizationId: auth.organizationId,
        projectId,
        provider: input.provider,
        providerCredentialId,
        providerCredentialScopeKey: providerCredential.scope_key,
        network: input.network,
        displayMetadata: buildTenantDisplayMetadata(credential),
        createdBy: userId,
        executor: tx,
      });

      return mapRpcConnection({
        ...connection,
        scope_key: scopeKey,
        credential_id: providerCredential.id,
        credential_label: providerCredential.label,
        credential_status: providerCredential.status,
      });
    });
  } catch (error) {
    // Best effort: an orphaned secret version is not reachable without its
    // credential row, but leaving it behind still costs money and audit noise.
    if (stored.secretVersionRef) {
      await secretStore
        .destroyVersion({ secretVersionRef: stored.secretVersionRef })
        .catch(() => {});
    }
    throw error;
  }
}

async function loadConnectionWithSecret(c: AppContext, connectionId: string) {
  const auth = getAuth(c);
  const store = new RpcConnectionStore(getDb(c.env));
  const scopeKeys = actingScopeKeys(c);
  const connection = await store.findConnection(auth.organizationId, connectionId, scopeKeys);
  if (!connection) {
    throw notFound("RPC connection");
  }
  return { auth, store, connection, scopeKeys };
}

/**
 * Activation probes the tenant's own endpoint before the relay is allowed to
 * depend on it. A failed probe records a redacted code and leaves the
 * connection unusable rather than silently falling back to platform keys.
 */
export async function activateRpcConnection(
  c: AppContext,
  connectionId: string,
  options: { makeDefault: boolean }
): Promise<SafeRpcConnection> {
  const { auth, store, connection, scopeKeys } = await loadConnectionWithSecret(c, connectionId);

  if (connection.status === "deactivated") {
    throw conflict("A deactivated RPC connection cannot be reactivated; create a new one");
  }

  const credential = await store.findConnectionSecret({
    organizationId: auth.organizationId,
    connectionId,
    scopeKeys,
  });
  if (!credential) {
    throw notFound("Provider credential");
  }

  // provider_credentials_storage_backend_check constrains this column to the
  // same three values, so narrowing once here is safe for both uses below.
  const storageBackend = credential.storage_backend as CredentialSecretStorageBackend;
  const secretStore = createCredentialSecretStore(c.env, storageBackend);
  const payload = await secretStore.read({
    orgId: auth.organizationId,
    stored: {
      storageBackend,
      secretRef: credential.secret_ref ?? undefined,
      secretVersionRef: credential.secret_version_ref ?? undefined,
      encryptedSecretPayload: credential.encrypted_secret_payload ?? undefined,
    },
  });

  const target = buildTenantRpcTarget(connection.provider as ByokRpcProvider, {
    endpointUrl: String(payload.endpointUrl ?? ""),
    apiKey: String(payload.apiKey ?? ""),
  });

  let probeOk = false;
  let failureCode = "provider_unreachable";
  try {
    // The endpoint came from the tenant, so the probe resolves it under the
    // egress guard: the stored host passed the literal check at submit time,
    // and this is what stops the name resolving somewhere internal now.
    const { upstream } = await probeRpcEndpoint(target, { enforcePublicEgress: true });
    probeOk = upstream.ok;
    if (!upstream.ok) {
      failureCode = toRedactedFailureCode(upstream.status);
    }
  } catch {
    probeOk = false;
  }

  if (!probeOk) {
    await store.recordCheckFailure({
      organizationId: auth.organizationId,
      connectionId,
      scopeKeys,
      failureCode,
    });
    throw conflict("The RPC provider rejected this connection", { failureCode });
  }

  const db = getDb(c.env);
  let activated: RpcConnectionRow | null;
  try {
    activated = await db.transaction(async (tx) => {
      const txStore = new RpcConnectionStore(tx);
      if (options.makeDefault) {
        await txStore.clearDefault({
          organizationId: auth.organizationId,
          scopeKey: connection.scope_key,
          network: connection.network,
          exceptConnectionId: connectionId,
          executor: tx,
        });
      }
      // The probe above is the evidence the key works, so the credential is
      // promoted out of `pending` here rather than anywhere else. It has to
      // share the transaction with the connection update: the relay's
      // effective-connection lookup requires both rows to agree, so a
      // half-applied activation would read healthy and still route to SDP.
      const promoted = await txStore.activateConnectionCredential({
        organizationId: auth.organizationId,
        connectionId,
        scopeKeys,
        executor: tx,
      });
      if (promoted === 0) {
        // Only a deactivated or retired credential reaches here. Activating the
        // connection anyway would produce the healthy-looking row that never
        // resolves, so fail loudly instead of leaving the two rows disagreeing.
        throw conflict("The credential behind this RPC connection is no longer usable");
      }

      return txStore.activateConnection({
        organizationId: auth.organizationId,
        connectionId,
        scopeKeys,
        makeDefault: options.makeDefault,
        executor: tx,
      });
    });
  } catch (error) {
    // Two administrators activating different defaults for the same scope and
    // network can both clear the previous one before either commits; the
    // partial unique index then rejects the loser. That is a conflict the
    // caller can retry, not an internal error.
    if (isDefaultConflict(error)) {
      throw conflict("Another connection was made the default at the same time");
    }
    throw error;
  }

  if (!activated) {
    throw conflict("The RPC connection changed while it was being activated");
  }

  // `credential` was read before the transaction, so its status is the
  // pre-promotion one. The transaction committed and refuses to commit without
  // promoting, so reporting `active` here is the state on disk, not a guess.
  return toSafeWithCredential(activated, { ...credential, status: "active" });
}

export async function deactivateRpcConnection(
  c: AppContext,
  connectionId: string
): Promise<SafeRpcConnection> {
  const { auth, store, scopeKeys } = await loadConnectionWithSecret(c, connectionId);

  const deactivated = await store.deactivateConnection({
    organizationId: auth.organizationId,
    connectionId,
    scopeKeys,
  });
  if (!deactivated) {
    throw conflict("The RPC connection is already deactivated");
  }

  const credential = await store.findConnectionSecret({
    organizationId: auth.organizationId,
    connectionId,
    scopeKeys,
  });

  return toSafeWithCredential(deactivated, credential);
}

function isDefaultConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("rpc_connections_one_default_per_scope_network") || message.includes("23505")
  );
}

function toSafeWithCredential(
  row: RpcConnectionRow,
  credential: { id: string; label: string; status: string } | null
): SafeRpcConnection {
  return mapRpcConnection({
    ...row,
    credential_id: credential?.id ?? row.provider_credential_id,
    credential_label: credential?.label ?? "",
    credential_status: credential?.status ?? "unknown",
  });
}
