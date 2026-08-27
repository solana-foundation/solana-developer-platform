import {
  assertReachableTenantEndpoint,
  type ByokRpcProvider,
  buildTenantDisplayMetadata,
  buildTenantRpcTarget,
  resolveTenantEndpoint,
  SOLANA_GENESIS_HASHES,
  type TenantRpcCredential,
} from "@sdp/rpc/byok";
import type {
  ProjectEnvironment,
  RpcConnectionNetwork,
  RpcConnectionTestResult,
  SafeRpcConnection,
} from "@sdp/types";
import type { Context } from "hono";
import { getDb } from "@/db";
import { parsePostgresJsonOr } from "@/db/postgres-utils";
import { getAuth } from "@/lib/auth";
import { badRequest, conflict, forbidden, internalError, notFound } from "@/lib/errors";
import { getLogger } from "@/runtime/logger";
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
  /**
   * Project-only since HOO-1226. Listing still accepts `organization` so rows
   * created before the cutover stay visible, but nothing new lands there.
   */
  scope: "project";
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

export type RpcCredentialMode = "managed" | "byok";

/**
 * Whose credentials this organization's RPC leaves on.
 *
 * `byok` is the Privy-shaped position: the organization is entirely on its own
 * keys, so a project without a live connection fails rather than quietly
 * spending SDP's. Reading it is separate from setting it because the relay
 * needs it on every request and the dashboard only on a settings page.
 */
export async function getRpcCredentialMode(
  c: AppContext
): Promise<{ mode: RpcCredentialMode; liveConnections: number }> {
  const auth = getAuth(c);

  // The count comes back with the mode because the two only mean something
  // together: `byok` with nothing live is an organization whose RPC is failing,
  // and the dashboard has to be able to say so. Neither read depends on the
  // other, so they go together rather than one after it.
  const [row, liveConnections] = await Promise.all([
    getDb(c.env)
      .prepare(`SELECT rpc_credential_mode FROM organizations WHERE id = ?`)
      .bind(auth.organizationId)
      .first<{ rpc_credential_mode: string }>(),
    new RpcConnectionStore(getDb(c.env)).countLiveConnectionsForOrganization({
      organizationId: auth.organizationId,
    }),
  ]);

  return {
    mode: row?.rpc_credential_mode === "byok" ? "byok" : "managed",
    liveConnections,
  };
}

/**
 * Switching to `byok` is a fail-closed promise, so it is refused while the
 * organization has nothing to fail closed onto: turning it on with no live
 * connection anywhere would break every project at once, which is never what
 * somebody means by the toggle.
 */
export async function setRpcCredentialMode(
  c: AppContext,
  mode: RpcCredentialMode
): Promise<{ mode: RpcCredentialMode }> {
  const auth = getAuth(c);
  requireUserId(c);

  if (mode === "byok") {
    const live = await new RpcConnectionStore(getDb(c.env)).countLiveConnectionsForOrganization({
      organizationId: auth.organizationId,
    });
    if (live === 0) {
      throw conflict(
        "Add a working RPC connection before moving this organization onto its own credentials"
      );
    }
  }

  await getDb(c.env)
    .prepare(
      `UPDATE organizations SET rpc_credential_mode = ?, updated_at = sdp_datetime_now() WHERE id = ?`
    )
    .bind(mode, auth.organizationId)
    .run();

  return { mode };
}

/**
 * Make one provider the thing that answers this project, whatever that takes.
 *
 * Choosing a provider and choosing whose credentials serve it used to be two
 * separate controls, and a tenant connection always outranked the platform
 * selection. So "Use this provider" wrote a setting the relay would not reach
 * and nothing observable changed: the page reported a different provider,
 * `/v1/rpc/test` answered from the old one, and the button read as broken.
 *
 * One action now covers both halves:
 *
 * - the project holds a key for this provider, so that key takes over;
 * - it does not, so nothing tenant-owned serves and SDP's account answers.
 *
 * The caller still writes the organization's selection. This decides only which
 * credential the project routes through, which is the half that was unreachable.
 */
export async function setServingRpcProvider(
  c: AppContext,
  provider: string
): Promise<{ servingProvider: string | null; usesOwnCredential: boolean }> {
  const auth = getAuth(c);
  requireUserId(c);
  const { projectId, scopeKey } = resolveScope(c, "project");
  if (!projectId) {
    throw badRequest("Selecting an RPC provider requires a selected project");
  }
  const network = await resolveProjectNetwork(c, projectId);

  const store = new RpcConnectionStore(getDb(c.env));
  const own = await store.findLiveConnectionForProvider({
    organizationId: auth.organizationId,
    scopeKey,
    network,
    provider,
  });

  if (own) {
    // Probes and promotes in one transaction, exactly as the row control did.
    // Reusing it keeps a switch from ever pointing the project at a key that
    // has stopped working since it was stored.
    await activateRpcConnection(c, own.id, { makeDefault: true });
    return { servingProvider: provider, usesOwnCredential: true };
  }

  // Nothing of the tenant's own for this provider. Standing down whatever is
  // serving is the entire point of the switch, so it is not optional -- but on
  // an organization that promised to run only on its own credentials it would
  // stop RPC rather than fall back, so that is refused instead of silently
  // stranding the project.
  const { mode } = await getRpcCredentialMode(c);
  if (mode === "byok") {
    throw conflict(
      "This organization runs entirely on its own credentials. Add a key for this provider before switching to it."
    );
  }

  await store.clearDefault({ organizationId: auth.organizationId, scopeKey, network });
  return { servingProvider: null, usesOwnCredential: false };
}

/**
 * The network is the project's, not a choice the form offers (HOO-1221).
 *
 * A sandbox project is devnet and a production project is mainnet, so picking
 * one separately only ever created the chance to disagree with the project the
 * connection hangs off. Deriving it is safe because a provider key is the same
 * on both networks -- only the URL differs -- so nothing about the credential
 * depends on which one is chosen.
 */
async function resolveProjectNetwork(
  c: AppContext,
  projectId: string
): Promise<RpcConnectionNetwork> {
  const project = await getDb(c.env)
    .prepare(`SELECT environment FROM projects WHERE id = ? AND organization_id = ?`)
    .bind(projectId, getAuth(c).organizationId)
    .first<{ environment: ProjectEnvironment }>();

  if (!project) {
    throw notFound("Project");
  }

  return project.environment === "production" ? "mainnet-beta" : "devnet";
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
  if (!projectId) {
    // `resolveScope` already throws for a project scope with no project; this
    // is the type-level half of the same rule.
    throw badRequest("An RPC connection requires a selected project");
  }

  const network = await resolveProjectNetwork(c, projectId);

  // A project holds one connection per provider, and exactly one of them
  // serves. That is what the partial unique index has always modelled --
  // many rows, one `is_default AND active` -- so lifting HOO-1227's
  // single-connection rule is this check rather than a migration.
  //
  // A second key on the *same* provider is still a rotation: two Alchemy
  // credentials on one project have no way to be told apart in the UI and
  // no meaning in the relay, which reads the default.
  const store = new RpcConnectionStore(getDb(c.env));
  const sameProvider = await store.countLiveConnections({
    organizationId: auth.organizationId,
    scopeKey,
    network,
    provider: input.provider,
  });
  if (sameProvider > 0) {
    throw conflict(
      "This project already has a connection for this provider. Rotate its key to replace it."
    );
  }

  // Adding a key must not move traffic off whatever is already serving.
  // Switching is a deliberate act on the connection, so a new one goes in
  // proven and idle unless the project has nothing serving it.
  const serving = await store.findScopeConnectionState({
    organizationId: auth.organizationId,
    scopeKey,
    network,
  });
  const shouldServe = serving.kind !== "active";

  const credential: TenantRpcCredential = {
    // A tenant only types an endpoint when their account has its own; for the
    // rest the provider's published host is used.
    endpointUrl: resolveTenantEndpoint(input.provider, network, input.endpointUrl),
    apiKey: input.apiKey,
  };

  // Reject an endpoint we cannot build a target from, or must never reach,
  // before anything is written -- no secret stored for a connection that can
  // never run, and no row that would point the relay at a private address.
  assertReachableTenantEndpoint(credential.endpointUrl);
  const target = buildTenantRpcTarget(input.provider, credential);

  // Saving runs the check (HOO-1228). A key that does not work never becomes a
  // row, so there is no draft state to explain and nothing to activate
  // afterwards: what gets saved is already known to serve traffic. The network
  // goes in so an endpoint on the wrong cluster is refused here rather than
  // recorded under a network it does not serve.
  const probe = await runConnectionProbe(target, network);
  if (!probe.ok) {
    throw conflict("The RPC provider rejected this connection", {
      failureCode: probe.failureCode,
    });
  }

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
        network,
        displayMetadata: buildTenantDisplayMetadata(credential),
        createdBy: userId,
        executor: tx,
      });

      // The probe above is the evidence, so the pair goes live here rather
      // than waiting for a separate activation. Both rows have to agree or the
      // relay's effective lookup reads healthy and still routes to SDP, which
      // is why this shares the insert's transaction.
      //
      // Only the connection that is taking over clears the incumbent. A key
      // added alongside a serving one is active and idle: proven, ready to be
      // switched to, routing nothing until someone asks for it.
      if (shouldServe) {
        await connectionStore.clearDefault({
          organizationId: auth.organizationId,
          scopeKey,
          network,
          exceptConnectionId: connectionId,
          executor: tx,
        });
      }
      await connectionStore.activateConnectionCredential({
        organizationId: auth.organizationId,
        connectionId,
        scopeKeys: [scopeKey],
        executor: tx,
      });
      const activated = await connectionStore.activateConnection({
        organizationId: auth.organizationId,
        connectionId,
        scopeKeys: [scopeKey],
        makeDefault: shouldServe,
        executor: tx,
      });

      return mapRpcConnection({
        ...(activated ?? connection),
        scope_key: scopeKey,
        credential_id: providerCredential.id,
        credential_label: providerCredential.label,
        credential_status: "active",
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

    // The serving check above is a read, so two saves racing each other both
    // see nothing serving and both try to become the default. The partial
    // unique index rejects the loser, and without this it would surface as an
    // unhandled database error rather than something the caller can act on.
    if (isDefaultConflict(error)) {
      throw conflict(
        "Another connection started serving this project at the same time. Add this one again, then switch to it."
      );
    }
    throw error;
  }
}

/**
 * One probe, one shape.
 *
 * Saving, activating and the on-demand test all ask the same question, and all
 * three must answer it without letting an upstream body through: the status is
 * reduced to a redacted code here so no caller can be handed a provider's own
 * words about a key.
 */
async function runConnectionProbe(
  target: ReturnType<typeof buildTenantRpcTarget>,
  network?: RpcConnectionNetwork
): Promise<RpcConnectionTestResult> {
  try {
    // The endpoint came from the tenant, so it resolves under the egress
    // guard: the host passed the literal check when it was submitted, and this
    // is what stops the name resolving somewhere internal now.
    //
    // `getGenesisHash` rather than `getVersion`: it proves reachability just
    // as well and also says which cluster answered. Every cluster answers
    // `getVersion` alike, so a mainnet endpoint passed on a sandbox project
    // and the row recorded `devnet` over it.
    const { upstream, upstreamBody } = await probeRpcEndpoint(target, {
      enforcePublicEgress: true,
      method: network ? "getGenesisHash" : "getVersion",
    });
    if (!upstream.ok) {
      return { ok: false, failureCode: toRedactedFailureCode(upstream.status) };
    }
    if (!network) {
      return { ok: true, failureCode: null };
    }

    const genesisHash = (upstreamBody as { result?: unknown } | null)?.result;
    if (typeof genesisHash !== "string") {
      // A 200 that carries no genesis hash is not this cluster answering, so
      // it cannot stand in for one.
      return { ok: false, failureCode: "provider_unreachable" };
    }
    return genesisHash === SOLANA_GENESIS_HASHES[network]
      ? { ok: true, failureCode: null }
      : { ok: false, failureCode: "network_mismatch" };
  } catch {
    return { ok: false, failureCode: "provider_unreachable" };
  }
}

/**
 * Read the stored secret for a connection and rebuild the target the relay
 * would use. Shared by activation and the on-demand test so neither can drift
 * into probing something the relay would not.
 */
async function loadConnectionTarget(c: AppContext, connectionId: string) {
  const { auth, store, connection, scopeKeys } = await loadConnectionWithSecret(c, connectionId);

  const credential = await store.findConnectionSecret({
    organizationId: auth.organizationId,
    connectionId,
    scopeKeys,
  });
  if (!credential) {
    throw notFound("Provider credential");
  }

  const storageBackend = credential.storage_backend as CredentialSecretStorageBackend;
  const payload = await createCredentialSecretStore(c.env, storageBackend).read({
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

  return { auth, store, connection, scopeKeys, credential, target };
}

/**
 * Check a stored connection on demand (HOO-1228).
 *
 * Nothing is written. Zach asked for "a subtle connection test afterwards
 * that's on trigger", and a test that quietly changed the connection's
 * lifecycle would be neither subtle nor a test.
 */
export async function testRpcConnection(
  c: AppContext,
  connectionId: string
): Promise<RpcConnectionTestResult> {
  const { connection, target } = await loadConnectionTarget(c, connectionId);
  return runConnectionProbe(target, connection.network);
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
 * depend on it. A failed probe marks the connection unusable rather than
 * silently falling back to platform keys.
 *
 * Saving now activates on its own (HOO-1228), so this is the recovery path: a
 * connection that failed its check later, and is being tried again.
 */
export async function activateRpcConnection(
  c: AppContext,
  connectionId: string,
  options: { makeDefault: boolean }
): Promise<SafeRpcConnection> {
  // Checked before the secret is read: deactivation destroys it, so loading
  // the target first would surface a missing-secret error instead of the
  // reason it is missing.
  const existing = await loadConnectionWithSecret(c, connectionId);
  if (existing.connection.status === "deactivated") {
    throw conflict("A deactivated RPC connection cannot be reactivated; create a new one");
  }

  const { auth, store, connection, scopeKeys, credential, target } = await loadConnectionTarget(
    c,
    connectionId
  );

  const probe = await runConnectionProbe(target, connection.network);
  if (!probe.ok) {
    // Qualified by the credential that was probed. A rotation can commit while
    // this probe is in flight, and writing the old verdict onto the connection
    // would fail a project closed over a key that has already been replaced.
    await store.markCheckFailed({
      organizationId: auth.organizationId,
      connectionId,
      providerCredentialId: credential.id,
      scopeKeys,
    });
    throw conflict("The RPC provider rejected this connection", {
      failureCode: probe.failureCode,
    });
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

export interface RotateRpcConnectionInput {
  /** Omitted for providers whose endpoint is the same for every account. */
  endpointUrl?: string;
  apiKey: string;
}

/**
 * Swap the key behind a connection without ever leaving the project dark
 * (HOO-1229).
 *
 * The old way was deactivate, add, activate: three steps, and the middle one
 * destroyed the working key before the replacement had been proven. Here the
 * new key is probed first and the old credential is only retired once the
 * replacement is committed, so the project is on one working key or the other
 * throughout.
 */
export async function rotateRpcConnection(
  c: AppContext,
  connectionId: string,
  input: RotateRpcConnectionInput
): Promise<SafeRpcConnection> {
  const auth = getAuth(c);
  const userId = requireUserId(c);
  const { store, connection, scopeKeys } = await loadConnectionWithSecret(c, connectionId);

  if (connection.status === "deactivated") {
    throw conflict("A deactivated RPC connection cannot be rotated; create a new one");
  }

  const previous = await store.findConnectionSecret({
    organizationId: auth.organizationId,
    connectionId,
    scopeKeys,
  });
  if (!previous) {
    throw notFound("Provider credential");
  }

  const provider = connection.provider as ByokRpcProvider;
  const candidate: TenantRpcCredential = {
    endpointUrl: resolveTenantEndpoint(provider, connection.network, input.endpointUrl),
    apiKey: input.apiKey,
  };

  assertReachableTenantEndpoint(candidate.endpointUrl);
  const target = buildTenantRpcTarget(provider, candidate);

  const probe = await runConnectionProbe(target, connection.network);
  if (!probe.ok) {
    // Nothing is touched. The connection carries on with the key it had.
    throw conflict("The RPC provider rejected the new key", { failureCode: probe.failureCode });
  }

  const nextCredentialId = `pcred_${crypto.randomUUID()}`;
  const secretStore = createCredentialSecretStore(c.env);
  const stored = await secretStore.write({
    orgId: auth.organizationId,
    provider,
    providerCredentialId: nextCredentialId,
    payload: { endpointUrl: candidate.endpointUrl, apiKey: input.apiKey },
  });

  let rotated: Awaited<ReturnType<RpcConnectionStore["repointConnectionCredential"]>>;
  try {
    rotated = await getDb(c.env).transaction(async (tx) => {
      const credentialStore = new ProviderCredentialStore(tx);
      const txStore = new RpcConnectionStore(tx);

      const next = await credentialStore.insertCredential({
        id: nextCredentialId,
        organizationId: auth.organizationId,
        projectId: connection.project_id,
        provider,
        label: previous.label,
        scope: connection.scope,
        source: "stored",
        stored,
        displayMetadata: buildTenantDisplayMetadata(candidate),
        version: (previous.credential_version ?? 1) + 1,
        rotatedFromId: previous.id,
        idempotencyKey: nextCredentialId,
        idempotencyFingerprint: nextCredentialId,
        createdBy: userId,
      });

      await txStore.activateCredentialById({
        organizationId: auth.organizationId,
        providerCredentialId: nextCredentialId,
        executor: tx,
      });

      const row = await txStore.repointConnectionCredential({
        organizationId: auth.organizationId,
        connectionId,
        scopeKeys,
        // Compare-and-swap against what this rotation read, so a second
        // rotation racing it loses rather than silently overwriting.
        expectedCredentialId: previous.id,
        nextCredentialId,
        nextCredentialScopeKey: next.scope_key,
        executor: tx,
      });
      if (!row) {
        throw conflict("The RPC connection changed while it was being rotated");
      }

      await txStore.retireCredential({
        organizationId: auth.organizationId,
        providerCredentialId: previous.id,
        executor: tx,
      });

      return row;
    });
  } catch (error) {
    if (stored.secretVersionRef) {
      await secretStore
        .destroyVersion({ secretVersionRef: stored.secretVersionRef })
        .catch(() => {});
    }
    throw error;
  }

  // Committed, so the old key is no longer reachable through any row. Dropping
  // the version is cleanup rather than part of the swap, and a failure here
  // must not undo a rotation that already succeeded.
  await destroyConnectionSecretBestEffort(c, previous);

  return toSafeWithCredential(rotated, {
    id: nextCredentialId,
    label: previous.label,
    status: "active",
  });
}

export async function deactivateRpcConnection(
  c: AppContext,
  connectionId: string
): Promise<SafeRpcConnection> {
  const { auth, store, scopeKeys } = await loadConnectionWithSecret(c, connectionId);

  const credential = await store.findConnectionSecret({
    organizationId: auth.organizationId,
    connectionId,
    scopeKeys,
  });

  // The connection and credential flips share one transaction: a crash
  // between them would leave a deactivated connection whose retry 409s while
  // the withdrawn credential silently stays active — the exact retention this
  // endpoint exists to end. The Secret Manager destroy stays outside; it is
  // best effort and must not roll back the committed deactivation.
  const deactivated = await getDb(c.env).transaction(async (tx) => {
    const txStore = new RpcConnectionStore(tx);
    const row = await txStore.deactivateConnection({
      organizationId: auth.organizationId,
      connectionId,
      scopeKeys,
      executor: tx,
    });
    if (!row) {
      throw conflict("The RPC connection is already deactivated");
    }
    const credentialFlips = await txStore.deactivateConnectionCredential({
      organizationId: auth.organizationId,
      connectionId,
      scopeKeys,
      executor: tx,
    });
    if (credentialFlips !== 1) {
      throw internalError("The credential behind this RPC connection did not deactivate");
    }
    return row;
  });

  await destroyConnectionSecretBestEffort(c, credential);

  return toSafeWithCredential(
    deactivated,
    credential ? { ...credential, status: "deactivated" } : null
  );
}

/**
 * Clear a deactivated connection out of the list (HOO-1219).
 *
 * Deactivation is terminal and already destroyed the secret, so these rows
 * could only accumulate: they cannot be reactivated and nothing routes through
 * them. Deleting takes the credential with it, in one transaction, so a crash
 * cannot leave a credential row pointing at a connection that is gone.
 */
export async function deleteRpcConnection(c: AppContext, connectionId: string): Promise<void> {
  const auth = getAuth(c);
  const scopeKeys = actingScopeKeys(c);

  await getDb(c.env).transaction(async (tx) => {
    const txStore = new RpcConnectionStore(tx);
    const deleted = await txStore.deleteDeactivatedConnection({
      organizationId: auth.organizationId,
      connectionId,
      scopeKeys,
      executor: tx,
    });

    if (!deleted) {
      // Either it does not exist for this caller or it is still live. The
      // second is the interesting one, and it is a conflict rather than a 404.
      const store = new RpcConnectionStore(tx);
      const existing = await store.findConnection(auth.organizationId, connectionId, scopeKeys);
      if (existing) {
        throw conflict("Deactivate this RPC connection before deleting it");
      }
      throw notFound("RPC connection");
    }

    await txStore.deleteOrphanedCredential({
      organizationId: auth.organizationId,
      providerCredentialId: deleted.provider_credential_id,
      executor: tx,
    });
  });
}

async function destroyConnectionSecretBestEffort(
  c: AppContext,
  credential: Awaited<ReturnType<RpcConnectionStore["findConnectionSecret"]>>
): Promise<void> {
  if (credential?.storage_backend !== "gcp_secret_manager" || !credential.secret_version_ref) {
    return;
  }

  try {
    // SAFETY: the guard above narrows storage_backend to "gcp_secret_manager".
    const store = createCredentialSecretStore(
      c.env,
      credential.storage_backend as CredentialSecretStorageBackend
    );
    await store.destroyVersion({ secretVersionRef: credential.secret_version_ref });
  } catch (err) {
    getLogger().error(
      {
        provider_credential_id: credential.id,
        storage_backend: credential.storage_backend,
        request_id: c.get("requestId"),
        reason: "secret_cleanup_failed",
        error: err instanceof Error ? err.message : String(err),
      },
      "rpc_connection_secret_orphan_risk"
    );
  }
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
