import { hashString } from "@sdp/payments/hash";
import { requireEnv } from "@sdp/payments/ramps/shared";
import type { Context } from "hono";
import { type DatabaseClient, getDb } from "@/db";
import { parsePostgresJsonOr } from "@/db/postgres-utils";
import { getAuth, requireProjectId } from "@/lib/auth";
import { AppError, conflict, forbidden, internalError, providerUnavailable } from "@/lib/errors";
import { isPrivyByokProvisioningEnabled } from "@/lib/feature-flags";
import { normalizeForFingerprint, resolveIdempotencyReplay } from "@/lib/idempotency";
import { AuditService } from "@/services/audit.service";
import * as credentialSecretStore from "@/services/credential-secret-store";
import {
  type CredentialSecretStore,
  CredentialSecretStoreError,
  type StoredCredentialSecret,
} from "@/services/credential-secret-store";
import { getProviderAvailability } from "@/services/provider-availability.service";
import {
  type CredentialReplay,
  type CustodyConnectionRow,
  hasPinnedProviderAccountIdentity,
  type ProjectConnectionState,
  type ProviderCredentialRow,
  ProviderCredentialStore,
} from "@/services/stores/provider-credential.store";
import type { Env } from "@/types/env";

const SETUP_CONFLICT_MESSAGE = "Privy custody setup already exists for this project";
const PROVISIONING_DISABLED_MESSAGE =
  "Stored credential provisioning is disabled for this provider";

interface SubmitPrivyCredentialInput {
  provider: "privy";
  fields: {
    credentialLabel: string;
    scope: "organization" | "project";
    appId: string;
    appSecret: string;
  };
}

interface SafeProviderCredential {
  id: string;
  provider: "privy";
  label: string;
  scope: "organization" | "project";
  projectId: string | null;
  status: ProviderCredentialRow["status"];
  createdAt: string;
  displayMetadata: { appIdSuffix?: string };
}

interface SafeCustodyConnection {
  id: string;
  projectId: string;
  provider: "privy";
  providerCredentialId: string;
  status: CustodyConnectionRow["status"];
  defaultCustodyWalletId: string | null;
  lastCheckStatus: string | null;
  lastCheckAt: string | null;
  lastCheckFailureCode: string | null;
  createdAt: string;
}

interface ProviderCredentialSubmissionResult {
  providerCredential: SafeProviderCredential;
  custodyConnection: SafeCustodyConnection;
}

type SetupPlan =
  | { kind: "first_install" }
  | { kind: "reinstall" }
  | {
      kind: "replacement";
      connection: ProjectConnectionState;
      currentCredential: ProviderCredentialRow;
    };

type TransactionResult =
  | { kind: "committed"; result: ProviderCredentialSubmissionResult }
  | { kind: "replay"; result: ProviderCredentialSubmissionResult };

type CompensationOutcome = "not_required" | "succeeded" | "failed" | "deferred";

type SubmissionAuditBase = {
  organizationId: string;
  userId: string;
  provider: "privy";
  scope: "organization" | "project";
};

interface SubmissionContext {
  c: Context<{ Bindings: Env }>;
  input: SubmitPrivyCredentialInput;
  idempotencyKey: string;
  organizationId: string;
  projectId: string;
  userId: string;
  db: DatabaseClient;
  store: ProviderCredentialStore;
  audit: AuditService;
  auditBase: SubmissionAuditBase;
}

interface PreparedSubmission extends SubmissionContext {
  fingerprint: string;
  preflightPlan: SetupPlan;
}

interface StoredSubmission extends PreparedSubmission {
  providerCredentialId: string;
  connectionId: string;
  secretStore: CredentialSecretStore;
  stored: StoredCredentialSecret;
}

class SetupConflict extends Error {
  constructor(readonly connectionId?: string) {
    super(SETUP_CONFLICT_MESSAGE);
  }
}

export async function submitProviderCredential(
  c: Context<{ Bindings: Env }>,
  input: SubmitPrivyCredentialInput,
  idempotencyKey: string
): Promise<ProviderCredentialSubmissionResult> {
  const context = createSubmissionContext(c, input, idempotencyKey);
  const fingerprint = await computeSubmissionFingerprint(context);
  const replay = await loadReplay(context);
  if (replay) {
    return resolveReplayWithAudit(context, replay, fingerprint);
  }

  const gateReplay = await enforceProvisioningGate(context, fingerprint);
  if (gateReplay) {
    return gateReplay;
  }

  const setup = await prepareSetup(context, fingerprint);
  if (setup.kind === "replay") {
    return setup.result;
  }

  return persistPreparedSubmission({
    ...context,
    fingerprint,
    preflightPlan: setup.plan,
  });
}

function createSubmissionContext(
  c: Context<{ Bindings: Env }>,
  input: SubmitPrivyCredentialInput,
  idempotencyKey: string
): SubmissionContext {
  const auth = getAuth(c);
  const organizationId = auth.organizationId;
  const projectId = requireProjectId(c);
  const userId = auth.userId;
  if (!userId || auth.authType !== "clerk") {
    throw internalError();
  }

  const db = getDb(c.env);
  const store = new ProviderCredentialStore(db);
  const audit = new AuditService(db);
  const auditBase = {
    organizationId,
    userId,
    provider: input.provider,
    scope: input.fields.scope,
  } satisfies SubmissionAuditBase;

  return {
    c,
    input,
    idempotencyKey,
    organizationId,
    projectId,
    userId,
    db,
    store,
    audit,
    auditBase,
  };
}

async function computeSubmissionFingerprint(context: SubmissionContext): Promise<string> {
  let pepper: string;
  try {
    pepper = requireEnv({ API_KEY_PEPPER: context.c.env.API_KEY_PEPPER }, "API_KEY_PEPPER");
  } catch {
    await auditFailure(context.c, context.audit, context.auditBase, {
      reason: "missing_fingerprint_pepper",
    });
    throw internalError();
  }

  try {
    return await buildProviderCredentialSubmissionFingerprint({
      organizationId: context.organizationId,
      projectId: context.projectId,
      input: context.input,
      pepper,
    });
  } catch {
    await auditFailure(context.c, context.audit, context.auditBase, {
      reason: "fingerprint_failed",
    });
    throw internalError();
  }
}

async function loadReplay(context: SubmissionContext): Promise<CredentialReplay | null> {
  try {
    return await context.store.findReplayByKey(
      context.organizationId,
      context.projectId,
      context.idempotencyKey
    );
  } catch {
    await auditFailure(context.c, context.audit, context.auditBase, {
      reason: "database_failure",
    });
    throw internalError();
  }
}

async function enforceProvisioningGate(
  context: SubmissionContext,
  fingerprint: string
): Promise<ProviderCredentialSubmissionResult | null> {
  const availability = await getProviderAvailability(
    context.c.env,
    context.db,
    context.organizationId
  );
  if (
    !availability.providers.custody.privy.entitled ||
    !isPrivyByokProvisioningEnabled(context.c.env)
  ) {
    const lateReplay = await resolveLateReplay({
      ...context,
      fingerprint,
    });
    if (lateReplay) {
      return lateReplay;
    }
    throw forbidden(PROVISIONING_DISABLED_MESSAGE);
  }
  return null;
}

async function prepareSetup(
  context: SubmissionContext,
  fingerprint: string
): Promise<
  { kind: "plan"; plan: SetupPlan } | { kind: "replay"; result: ProviderCredentialSubmissionResult }
> {
  try {
    return {
      kind: "plan",
      plan: await classifySetup(context.store, context.organizationId, context.projectId),
    };
  } catch (error) {
    if (error instanceof SetupConflict) {
      const lateReplay = await resolveLateReplay({
        ...context,
        fingerprint,
      });
      if (lateReplay) {
        return { kind: "replay", result: lateReplay };
      }
      await auditFailure(context.c, context.audit, context.auditBase, {
        reason: "setup_conflict",
        connectionId: error.connectionId,
      });
      throw conflict(SETUP_CONFLICT_MESSAGE);
    }
    await auditFailure(context.c, context.audit, context.auditBase, {
      reason: "database_failure",
    });
    throw internalError();
  }
}

async function persistPreparedSubmission(
  prepared: PreparedSubmission
): Promise<ProviderCredentialSubmissionResult> {
  const providerCredentialId = `pcred_${crypto.randomUUID()}`;
  const connectionId =
    prepared.preflightPlan.kind === "replacement"
      ? prepared.preflightPlan.connection.id
      : `cconn_${crypto.randomUUID()}`;

  const secretStore = await createSubmissionSecretStore(
    prepared,
    providerCredentialId,
    connectionId
  );
  const stored = await writeSubmissionSecret(
    prepared,
    providerCredentialId,
    connectionId,
    secretStore
  );

  return commitStoredSubmission({
    ...prepared,
    providerCredentialId,
    connectionId,
    secretStore,
    stored,
  });
}

async function createSubmissionSecretStore(
  context: SubmissionContext,
  providerCredentialId: string,
  connectionId: string
): Promise<CredentialSecretStore> {
  let store: CredentialSecretStore;
  try {
    store = credentialSecretStore.createCredentialSecretStore(context.c.env);
  } catch {
    await auditFailure(context.c, context.audit, context.auditBase, {
      reason: "secret_store_configuration",
      resourceId: providerCredentialId,
      connectionId,
    });
    throw internalError();
  }

  if (store.storageBackend === "runtime_env") {
    await auditFailure(context.c, context.audit, context.auditBase, {
      reason: "unsupported_storage_backend",
      resourceId: providerCredentialId,
      connectionId,
      storageBackend: store.storageBackend,
    });
    throw internalError();
  }
  return store;
}

async function writeSubmissionSecret(
  context: SubmissionContext,
  providerCredentialId: string,
  connectionId: string,
  secretStore: CredentialSecretStore
): Promise<StoredCredentialSecret> {
  try {
    return await secretStore.write({
      orgId: context.organizationId,
      provider: context.input.provider,
      providerCredentialId,
      payload: {
        appId: context.input.fields.appId,
        appSecret: context.input.fields.appSecret,
      },
    });
  } catch (error) {
    const upstream = error instanceof CredentialSecretStoreError && error.code === "UPSTREAM_ERROR";
    if (upstream && secretStore.storageBackend === "gcp_secret_manager") {
      logOrphanRisk({
        providerCredentialId,
        storageBackend: secretStore.storageBackend,
        requestId: context.c.get("requestId"),
        reason: "secret_write_outcome_unknown",
      });
    }
    await auditFailure(context.c, context.audit, context.auditBase, {
      reason: upstream ? "secret_store_unavailable" : "secret_store_failure",
      resourceId: providerCredentialId,
      connectionId,
      storageBackend: secretStore.storageBackend,
    });
    if (upstream) {
      throw providerUnavailable("Credential storage is temporarily unavailable");
    }
    throw internalError();
  }
}

async function commitStoredSubmission(
  submission: StoredSubmission
): Promise<ProviderCredentialSubmissionResult> {
  let transactionResult: TransactionResult;
  try {
    transactionResult = await runSubmissionTransaction(submission);
  } catch (error) {
    return recoverTransactionFailure(submission, error);
  }

  if (transactionResult.kind === "replay") {
    await compensateSecretWrite(
      submission.c,
      submission.secretStore,
      submission.stored,
      submission.providerCredentialId
    );
    return transactionResult.result;
  }

  await auditSubmissionSuccess(submission, transactionResult.result);
  return transactionResult.result;
}

async function auditSubmissionSuccess(
  submission: StoredSubmission,
  result: ProviderCredentialSubmissionResult
): Promise<void> {
  await submission.audit.log(submission.c, {
    organizationId: submission.organizationId,
    userId: submission.userId,
    action: "submit",
    resourceType: "provider_credential",
    resourceId: submission.providerCredentialId,
    status: "success",
    metadata: {
      event: "provider_credential_submitted",
      provider: submission.input.provider,
      scope: submission.input.fields.scope,
      storageBackend: submission.stored.storageBackend,
      credentialStatus: result.providerCredential.status,
      connectionId: result.custodyConnection.id,
    },
  });
}

async function runSubmissionTransaction(submission: StoredSubmission): Promise<TransactionResult> {
  return submission.db.transaction(async (tx) => {
    const txStore = new ProviderCredentialStore(tx);
    if (!(await txStore.lockProject(submission.organizationId, submission.projectId))) {
      throw new Error("Project disappeared during credential submission");
    }

    const concurrentReplay = await txStore.findReplayByKey(
      submission.organizationId,
      submission.projectId,
      submission.idempotencyKey
    );
    if (concurrentReplay) {
      return {
        kind: "replay",
        result: await resolveReplay(concurrentReplay, submission.fingerprint),
      };
    }

    const lockedPlan = await classifySetup(
      txStore,
      submission.organizationId,
      submission.projectId,
      true
    );
    assertSameSetupPlan(submission.preflightPlan, lockedPlan);

    const version =
      lockedPlan.kind === "replacement" ? lockedPlan.currentCredential.credential_version + 1 : 1;
    const rotatedFromId =
      lockedPlan.kind === "replacement" ? lockedPlan.currentCredential.id : null;
    const credentialProjectId =
      submission.input.fields.scope === "project" ? submission.projectId : null;
    const displayMetadata: Record<string, string> =
      submission.input.fields.appId.length > 4
        ? { appIdSuffix: submission.input.fields.appId.slice(-4) }
        : {};

    const providerCredential = await txStore.insertCredential({
      id: submission.providerCredentialId,
      organizationId: submission.organizationId,
      projectId: credentialProjectId,
      label: submission.input.fields.credentialLabel,
      scope: submission.input.fields.scope,
      stored: submission.stored,
      displayMetadata,
      version,
      rotatedFromId,
      idempotencyKey: submission.idempotencyKey,
      idempotencyFingerprint: submission.fingerprint,
      createdBy: submission.userId,
    });
    const custodyConnection = await persistConnection(
      txStore,
      submission,
      lockedPlan,
      providerCredential
    );

    return {
      kind: "committed",
      result: mapSubmissionResult(providerCredential, custodyConnection),
    };
  });
}

async function persistConnection(
  store: ProviderCredentialStore,
  submission: StoredSubmission,
  lockedPlan: SetupPlan,
  providerCredential: ProviderCredentialRow
): Promise<CustodyConnectionRow> {
  if (lockedPlan.kind !== "replacement") {
    return store.insertConnection({
      id: submission.connectionId,
      organizationId: submission.organizationId,
      projectId: submission.projectId,
      providerCredentialId: submission.providerCredentialId,
      providerCredentialScopeKey: providerCredential.scope_key,
      createdBy: submission.userId,
    });
  }

  const updated = await store.resetFailedConnection({
    id: lockedPlan.connection.id,
    expectedProviderCredentialId: lockedPlan.currentCredential.id,
    providerCredentialId: submission.providerCredentialId,
    providerCredentialScopeKey: providerCredential.scope_key,
  });
  if (!updated) {
    throw new SetupConflict(lockedPlan.connection.id);
  }
  return updated;
}

async function recoverTransactionFailure(
  submission: StoredSubmission,
  error: unknown
): Promise<ProviderCredentialSubmissionResult> {
  const reconciliation = await reconcileTransactionOutcome(submission);
  if (reconciliation.kind === "found") {
    if (reconciliation.replay.providerCredential.id === submission.providerCredentialId) {
      const committed = await resolveReplay(reconciliation.replay, submission.fingerprint);
      await auditSubmissionSuccess(submission, committed);
      return committed;
    }

    const compensationOutcome = await compensateSecretWrite(
      submission.c,
      submission.secretStore,
      submission.stored,
      submission.providerCredentialId
    );
    return resolveReplayWithAudit(submission, reconciliation.replay, submission.fingerprint, {
      failureResourceId: submission.providerCredentialId,
      compensationOutcome,
    });
  }

  if (reconciliation.kind === "unknown") {
    reportManualSecretCleanupRequired(submission);
    await auditFailure(submission.c, submission.audit, submission.auditBase, {
      reason: "database_failure",
      resourceId: submission.providerCredentialId,
      connectionId: submission.connectionId,
      storageBackend: submission.stored.storageBackend,
      compensationOutcome:
        submission.stored.storageBackend === "gcp_secret_manager" ? "deferred" : "not_required",
    });
    throw internalError();
  }

  const compensationOutcome = await compensateSecretWrite(
    submission.c,
    submission.secretStore,
    submission.stored,
    submission.providerCredentialId
  );

  if (error instanceof SetupConflict) {
    await auditFailure(submission.c, submission.audit, submission.auditBase, {
      reason: "setup_conflict",
      resourceId: submission.providerCredentialId,
      connectionId: error.connectionId ?? submission.connectionId,
      storageBackend: submission.stored.storageBackend,
      compensationOutcome,
    });
    throw conflict(SETUP_CONFLICT_MESSAGE);
  }

  if (error instanceof AppError && error.code === "CONFLICT") {
    await auditFailure(submission.c, submission.audit, submission.auditBase, {
      reason: "idempotency_key_reused",
      resourceId: submission.providerCredentialId,
      connectionId: submission.connectionId,
      storageBackend: submission.stored.storageBackend,
      compensationOutcome,
    });
    throw error;
  }

  await auditFailure(submission.c, submission.audit, submission.auditBase, {
    reason: "database_failure",
    resourceId: submission.providerCredentialId,
    connectionId: submission.connectionId,
    storageBackend: submission.stored.storageBackend,
    compensationOutcome,
  });
  throw internalError();
}

async function reconcileTransactionOutcome(
  submission: StoredSubmission
): Promise<{ kind: "found"; replay: CredentialReplay } | { kind: "absent" } | { kind: "unknown" }> {
  try {
    const replay = await submission.store.findReplayByKey(
      submission.organizationId,
      submission.projectId,
      submission.idempotencyKey
    );
    return replay ? { kind: "found", replay } : { kind: "absent" };
  } catch {
    return { kind: "unknown" };
  }
}

function reportManualSecretCleanupRequired(submission: StoredSubmission): void {
  if (submission.stored.storageBackend !== "gcp_secret_manager") {
    return;
  }

  logOrphanRisk({
    providerCredentialId: submission.providerCredentialId,
    storageBackend: submission.stored.storageBackend,
    providerResourceVersion: submission.stored.secretVersionRef
      ? parseProviderResourceVersion(submission.stored.secretVersionRef)
      : undefined,
    requestId: submission.c.get("requestId"),
    reason: "secret_cleanup_failed",
  });
}

async function buildProviderCredentialSubmissionFingerprint(params: {
  organizationId: string;
  projectId: string;
  input: SubmitPrivyCredentialInput;
  pepper: string;
}): Promise<string> {
  const canonical = JSON.stringify(
    normalizeForFingerprint({
      version: 1,
      operation: "provider_credential_submission",
      target: {
        organizationId: params.organizationId,
        projectId: params.projectId,
      },
      provider: params.input.provider,
      fields: params.input.fields,
    })
  );
  return hashString(canonical, params.pepper);
}

async function resolveReplay(
  replay: CredentialReplay,
  fingerprint: string
): Promise<ProviderCredentialSubmissionResult> {
  await resolveIdempotencyReplay(async () => replay.providerCredential, fingerprint);
  if (replay.custodyConnections.length !== 1) {
    throw internalError();
  }
  return mapSubmissionResult(
    replay.providerCredential,
    replay.custodyConnections[0] as CustodyConnectionRow
  );
}

async function resolveReplayWithAudit(
  context: Pick<SubmissionContext, "c" | "audit" | "auditBase">,
  replay: CredentialReplay,
  fingerprint: string,
  failure?: {
    failureResourceId?: string;
    compensationOutcome?: CompensationOutcome;
  }
): Promise<ProviderCredentialSubmissionResult> {
  try {
    return await resolveReplay(replay, fingerprint);
  } catch (error) {
    if (error instanceof AppError && error.code === "CONFLICT") {
      await auditFailure(context.c, context.audit, context.auditBase, {
        reason: "idempotency_key_reused",
        resourceId: failure?.failureResourceId,
        compensationOutcome: failure?.compensationOutcome,
      });
    }
    throw error;
  }
}

async function resolveLateReplay(params: {
  c: Context<{ Bindings: Env }>;
  store: ProviderCredentialStore;
  audit: AuditService;
  auditBase: {
    organizationId: string;
    userId: string;
    provider: "privy";
    scope: "organization" | "project";
  };
  organizationId: string;
  projectId: string;
  idempotencyKey: string;
  fingerprint: string;
}): Promise<ProviderCredentialSubmissionResult | null> {
  let replay: CredentialReplay | null;
  try {
    replay = await params.store.findReplayByKey(
      params.organizationId,
      params.projectId,
      params.idempotencyKey
    );
  } catch {
    await auditFailure(params.c, params.audit, params.auditBase, {
      reason: "database_failure",
    });
    throw internalError();
  }
  if (!replay) {
    return null;
  }
  return resolveReplayWithAudit(params, replay, params.fingerprint);
}

async function classifySetup(
  store: ProviderCredentialStore,
  organizationId: string,
  projectId: string,
  lock = false
): Promise<SetupPlan> {
  const connections = await store.listProjectConnections(organizationId, projectId, { lock });
  const activeLegacyConfig = await store.hasActiveProjectLegacyConfig(organizationId, projectId);
  if (activeLegacyConfig) {
    throw new SetupConflict();
  }

  const nonDeactivated = connections.filter((connection) => connection.status !== "deactivated");
  if (nonDeactivated.length === 0) {
    return connections.length === 0 ? { kind: "first_install" } : { kind: "reinstall" };
  }

  if (nonDeactivated.length !== 1) {
    throw new SetupConflict(nonDeactivated[0]?.id);
  }

  const connection = nonDeactivated[0] as ProjectConnectionState;
  if (
    connection.status !== "failed" ||
    connection.credential_status !== "failed_validation" ||
    connection.activated_at !== null ||
    connection.default_custody_wallet_id !== null ||
    hasPinnedProviderAccountIdentity(connection.setup_metadata)
  ) {
    throw new SetupConflict(connection.id);
  }

  const currentCredential = await store.findCredential(connection.provider_credential_id, { lock });
  if (
    currentCredential?.status !== "failed_validation" ||
    currentCredential.credential_version !== connection.credential_version
  ) {
    throw new SetupConflict(connection.id);
  }

  return {
    kind: "replacement",
    connection,
    currentCredential,
  };
}

function assertSameSetupPlan(preflight: SetupPlan, locked: SetupPlan): void {
  if (preflight.kind !== locked.kind) {
    throw new SetupConflict(locked.kind === "replacement" ? locked.connection.id : undefined);
  }
  if (
    preflight.kind === "replacement" &&
    locked.kind === "replacement" &&
    (preflight.connection.id !== locked.connection.id ||
      preflight.currentCredential.id !== locked.currentCredential.id ||
      preflight.currentCredential.credential_version !==
        locked.currentCredential.credential_version)
  ) {
    throw new SetupConflict(locked.connection.id);
  }
}

function mapSubmissionResult(
  providerCredential: ProviderCredentialRow,
  custodyConnection: CustodyConnectionRow
): ProviderCredentialSubmissionResult {
  return {
    providerCredential: mapProviderCredential(providerCredential),
    custodyConnection: mapCustodyConnection(custodyConnection),
  };
}

function mapProviderCredential(row: ProviderCredentialRow): SafeProviderCredential {
  const storedMetadata = parsePostgresJsonOr<Record<string, unknown>>(row.display_metadata, {});
  const appIdSuffix =
    typeof storedMetadata.appIdSuffix === "string" ? storedMetadata.appIdSuffix : undefined;

  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    scope: row.scope,
    projectId: row.project_id,
    status: row.status,
    createdAt: row.created_at,
    displayMetadata: appIdSuffix ? { appIdSuffix } : {},
  };
}

function mapCustodyConnection(row: CustodyConnectionRow): SafeCustodyConnection {
  return {
    id: row.id,
    projectId: row.project_id,
    provider: row.provider,
    providerCredentialId: row.provider_credential_id,
    status: row.status,
    defaultCustodyWalletId: row.default_custody_wallet_id,
    lastCheckStatus: row.last_check_status,
    lastCheckAt: row.last_check_at,
    lastCheckFailureCode: row.last_check_failure_code,
    createdAt: row.created_at,
  };
}

async function compensateSecretWrite(
  c: Context<{ Bindings: Env }>,
  store: CredentialSecretStore,
  stored: StoredCredentialSecret,
  providerCredentialId: string
): Promise<CompensationOutcome> {
  if (stored.storageBackend !== "gcp_secret_manager" || !stored.secretVersionRef) {
    return "not_required";
  }

  try {
    await store.destroyVersion({ secretVersionRef: stored.secretVersionRef });
    return "succeeded";
  } catch {
    logOrphanRisk({
      providerCredentialId,
      storageBackend: stored.storageBackend,
      providerResourceVersion: parseProviderResourceVersion(stored.secretVersionRef),
      requestId: c.get("requestId"),
      reason: "secret_cleanup_failed",
    });
    return "failed";
  }
}

function parseProviderResourceVersion(secretVersionRef: string): number | undefined {
  const value = secretVersionRef.split("/").at(-1);
  if (!value || !/^[1-9][0-9]*$/.test(value)) {
    return undefined;
  }
  return Number(value);
}

function logOrphanRisk(params: {
  providerCredentialId: string;
  storageBackend: "gcp_secret_manager";
  providerResourceVersion?: number;
  requestId: string;
  reason: "secret_write_outcome_unknown" | "secret_cleanup_failed";
}): void {
  console.error("provider_credential_orphan_risk", {
    providerCredentialId: params.providerCredentialId,
    provider: "privy",
    storageBackend: params.storageBackend,
    ...(params.providerResourceVersion !== undefined && {
      providerResourceVersion: params.providerResourceVersion,
    }),
    requestId: params.requestId,
    reason: params.reason,
  });
}

async function auditFailure(
  c: Context<{ Bindings: Env }>,
  audit: AuditService,
  base: {
    organizationId: string;
    userId: string;
    provider: "privy";
    scope: "organization" | "project";
  },
  failure: {
    reason: string;
    resourceId?: string;
    connectionId?: string;
    storageBackend?: string;
    compensationOutcome?: CompensationOutcome;
  }
): Promise<void> {
  await audit.log(c, {
    organizationId: base.organizationId,
    userId: base.userId,
    action: "submit_failed",
    resourceType: "provider_credential",
    resourceId: failure.resourceId,
    status: "failure",
    metadata: {
      provider: base.provider,
      scope: base.scope,
      reason: failure.reason,
      ...(failure.connectionId && { connectionId: failure.connectionId }),
      ...(failure.storageBackend && {
        storageBackend: failure.storageBackend,
      }),
      ...(failure.compensationOutcome && {
        compensationOutcome: failure.compensationOutcome,
      }),
    },
  });
}
