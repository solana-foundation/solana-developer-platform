import type { Context } from "hono";
import { type DatabaseClient, type DatabaseExecutor, getDb } from "@/db";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import { getAuth, requireProjectId } from "@/lib/auth";
import { badRequest, conflict, internalError, providerUnavailable } from "@/lib/errors";
import { resolveNewCustodySetupMethod } from "@/lib/feature-flags";
import { normalizeForFingerprint, resolveIdempotencyReplay } from "@/lib/idempotency";
import { assertProviderAvailable } from "@/services/provider-availability.service";
import {
  completeRuntimeProviderCredentialInstallation,
  type ProviderCredentialCompletionResult,
} from "@/services/provider-credential-installation.service";
import {
  type ProviderCredentialRow,
  ProviderCredentialStore,
} from "@/services/stores/provider-credential.store";
import type { Env } from "@/types/env";

const RUNTIME_CREDENTIAL_LABEL = "Privy runtime credentials";

interface DeploymentCredentialInitializeRequest {
  provider: "privy";
  requestDelayMs?: number;
  walletLabel?: string;
}

export interface DeploymentCredentialInitializationResult {
  connectionId: string;
  publicKey: string;
  walletId: string;
}

export async function tryInitializePrivyFromDeploymentCredentials(
  c: Context<{ Bindings: Env }>,
  request: DeploymentCredentialInitializeRequest
): Promise<DeploymentCredentialInitializationResult | null> {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  const db = getDb(c.env);
  const idempotencyKey = c.req.header("Idempotency-Key");
  const fingerprint = buildRuntimeInitializationFingerprint(
    auth.organizationId,
    projectId,
    request
  );

  if (idempotencyKey) {
    const replay = await findRuntimeReplay(
      new ProviderCredentialStore(db),
      auth.organizationId,
      projectId,
      idempotencyKey,
      fingerprint
    );
    if (replay) {
      return completeRuntimeInitialization(c, db, auth.organizationId, projectId, replay);
    }
  }

  if (resolveNewCustodySetupMethod(c.env, "privy") !== "deployment_credentials") {
    return null;
  }
  if (await hasActiveProjectPrivyConfig(db, auth.organizationId, projectId)) {
    return null;
  }
  if (!idempotencyKey) {
    throw badRequest("Idempotency-Key is required");
  }

  await assertProviderAvailable(c.env, db, auth.organizationId, "custody", "privy");
  const connectionId = await createRuntimeAttempt({
    db,
    organizationId: auth.organizationId,
    projectId,
    createdBy: auth.userId,
    idempotencyKey,
    fingerprint,
    walletLabel: request.walletLabel,
  });
  if (!connectionId) {
    return null;
  }
  return completeRuntimeInitialization(c, db, auth.organizationId, projectId, connectionId);
}

function buildRuntimeInitializationFingerprint(
  organizationId: string,
  projectId: string,
  request: DeploymentCredentialInitializeRequest
): string {
  return JSON.stringify(
    normalizeForFingerprint({
      operation: "runtime_custody_initialize",
      organizationId,
      projectId,
      provider: request.provider,
      requestDelayMs: request.requestDelayMs ?? null,
      walletLabel: request.walletLabel ?? null,
    })
  );
}

async function createRuntimeAttempt(params: {
  db: DatabaseClient;
  organizationId: string;
  projectId: string;
  createdBy: string | null;
  idempotencyKey: string;
  fingerprint: string;
  walletLabel?: string;
}): Promise<string | null> {
  const providerCredentialId = `pcred_${crypto.randomUUID()}`;
  const connectionId = `cconn_${crypto.randomUUID()}`;
  try {
    return await params.db.transaction(async (tx) => {
      const store = new ProviderCredentialStore(tx);
      if (!(await store.lockProject(params.organizationId, params.projectId))) {
        throw internalError();
      }

      const replay = await findRuntimeReplay(
        store,
        params.organizationId,
        params.projectId,
        params.idempotencyKey,
        params.fingerprint
      );
      if (replay) {
        return replay;
      }
      if (await hasActiveProjectPrivyConfig(tx, params.organizationId, params.projectId)) {
        return null;
      }

      const blocking = (
        await store.listProjectConnections(params.organizationId, params.projectId, {
          lock: true,
        })
      ).find((connection) => ["pending", "checking", "active"].includes(connection.status));
      if (blocking) {
        throw conflict("Privy custody setup already exists for this project");
      }

      const credential = await store.insertCredential({
        id: providerCredentialId,
        organizationId: params.organizationId,
        projectId: params.projectId,
        label: RUNTIME_CREDENTIAL_LABEL,
        scope: "project",
        source: "runtime",
        stored: { storageBackend: "runtime_env" },
        displayMetadata: {},
        version: 1,
        rotatedFromId: null,
        idempotencyKey: params.idempotencyKey,
        idempotencyFingerprint: params.fingerprint,
        createdBy: params.createdBy,
      });
      await store.insertConnection({
        id: connectionId,
        organizationId: params.organizationId,
        projectId: params.projectId,
        providerCredentialId: credential.id,
        providerCredentialScopeKey: credential.scope_key,
        pendingWalletLabel: params.walletLabel,
        createdBy: params.createdBy,
      });
      return connectionId;
    });
  } catch (error) {
    if (!isPostgresUniqueViolation(error)) {
      throw error;
    }
    const replay = await findRuntimeReplay(
      new ProviderCredentialStore(params.db),
      params.organizationId,
      params.projectId,
      params.idempotencyKey,
      params.fingerprint
    );
    if (replay) {
      return replay;
    }
    throw conflict("Privy custody setup already exists for this project");
  }
}

async function findRuntimeReplay(
  store: ProviderCredentialStore,
  organizationId: string,
  projectId: string,
  idempotencyKey: string,
  fingerprint: string
): Promise<string | null> {
  const credential = await resolveIdempotencyReplay(
    () => store.findReplayByKey(organizationId, idempotencyKey),
    fingerprint
  );
  if (!credential) {
    return null;
  }
  assertRuntimeReplayCredential(credential, organizationId, projectId);
  const connectionIds = await store.findConnectionIdsForCredentialLineage(
    organizationId,
    projectId,
    credential.id
  );
  if (connectionIds.length !== 1) {
    throw internalError();
  }
  return connectionIds[0];
}

function assertRuntimeReplayCredential(
  credential: ProviderCredentialRow,
  organizationId: string,
  projectId: string
): void {
  if (
    credential.organization_id !== organizationId ||
    credential.project_id !== projectId ||
    credential.provider !== "privy" ||
    credential.scope !== "project"
  ) {
    throw internalError();
  }
}

async function completeRuntimeInitialization(
  c: Context<{ Bindings: Env }>,
  db: DatabaseClient,
  organizationId: string,
  projectId: string,
  connectionId: string
): Promise<DeploymentCredentialInitializationResult> {
  const result = await completeRuntimeProviderCredentialInstallation(c, connectionId);
  if (result.completion.status === "failed") {
    throw completionFailure(result);
  }
  if (result.completion.status === "retry_unknown") {
    throw providerUnavailable(
      "Privy setup outcome is unknown; retry with the same Idempotency-Key"
    );
  }

  const wallet = await db.queryOne<{ wallet_id: string; public_key: string }>(
    `SELECT wallet.wallet_id, wallet.public_key
     FROM custody_connections connection
     JOIN provider_credentials credential
       ON credential.id = connection.provider_credential_id
     JOIN custody_wallets wallet
       ON wallet.id = connection.default_custody_wallet_id
      AND wallet.custody_connection_id = connection.id
     WHERE connection.id = ?
       AND connection.organization_id = ?
       AND connection.project_id = ?
       AND connection.status = 'active'
       AND connection.last_check_status = 'success'
       AND credential.source = 'runtime'
       AND credential.status = 'active'
       AND wallet.status = 'active'`,
    [connectionId, organizationId, projectId]
  );
  if (!wallet) {
    throw internalError();
  }
  return { connectionId, walletId: wallet.wallet_id, publicKey: wallet.public_key };
}

function completionFailure(result: ProviderCredentialCompletionResult): Error {
  if (result.completion.code === "invalid_credentials") {
    return badRequest("Privy credentials are invalid");
  }
  if (result.completion.code === "provider_account_already_connected") {
    return conflict("Privy Provider account is already connected");
  }
  return conflict("Privy wallet cannot be reconciled");
}

async function hasActiveProjectPrivyConfig(
  db: Pick<DatabaseExecutor, "queryOne">,
  organizationId: string,
  projectId: string
): Promise<boolean> {
  return Boolean(
    await db.queryOne<{ id: string }>(
      `SELECT id
       FROM custody_configs
       WHERE organization_id = ?
         AND project_id = ?
         AND provider = 'privy'
         AND status = 'active'
       LIMIT 1`,
      [organizationId, projectId]
    )
  );
}
