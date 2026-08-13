import { hashString } from "@sdp/payments/hash";
import { requireEnv } from "@sdp/payments/ramps/shared";
import type { Context } from "hono";
import { type DatabaseClient, getDb } from "@/db";
import { isPostgresUniqueViolation, parsePostgresJsonOr } from "@/db/postgres-utils";
import { getAuth, requireProjectId } from "@/lib/auth";
import {
  AppError,
  badRequest,
  conflict,
  forbidden,
  internalError,
  notFound,
  providerUnavailable,
} from "@/lib/errors";
import { resolveNewCustodySetupMethod } from "@/lib/feature-flags";
import { normalizeForFingerprint, resolveIdempotencyReplay } from "@/lib/idempotency";
import { getLogger } from "@/runtime/logger";
import { type AuditIntent, AuditService } from "@/services/audit.service";
import * as credentialSecretStore from "@/services/credential-secret-store";
import {
  type CredentialSecretStore,
  CredentialSecretStoreError,
  type StoredCredentialSecret,
} from "@/services/credential-secret-store";
import { isPersistedCustodyCompletionEnabled } from "@/services/provider-availability.service";
import {
  decideInstallation,
  type InstallationConflictReason,
  installationFactsFromConnection,
} from "@/services/provider-credential-installation";
import {
  type ProjectConnectionState,
  type ProviderCredentialRow,
  ProviderCredentialStore,
} from "@/services/stores/provider-credential.store";
import type { Env } from "@/types/env";

const UNFINISHED_INSTALLATION_MESSAGE =
  "A Privy custody installation is already in progress for this project";
const REPLACEMENT_CONFLICT_MESSAGE = "Custody Connection cannot accept replacement credentials";
const PROVISIONING_DISABLED_MESSAGE = "Custody Connection setup is disabled for this provider";
const RUNTIME_CREDENTIAL_LABEL = "Privy runtime credentials";

interface PrivyCredentialFields {
  credentialLabel: string;
  scope: "project";
  appId: string;
  appSecret: string;
}

interface SubmitPrivyCredentialInput {
  provider: "privy";
  requestDelayMs?: number;
  walletLabel?: string;
  fields?: PrivyCredentialFields;
}

type StoredPrivyCredentialInput = SubmitPrivyCredentialInput & { fields: PrivyCredentialFields };
type SubmissionSource = "stored" | "runtime";

export interface SafeProviderCredential {
  id: string;
  provider: "privy";
  label: string;
  scope: "organization" | "project";
  projectId: string | null;
  status: ProviderCredentialRow["status"];
  createdAt: string;
  displayMetadata: { appIdSuffix?: string };
}

export interface ProviderCredentialSubmissionResult {
  providerCredential: SafeProviderCredential;
  connectionId: string;
}

type SetupPlan =
  | { kind: "fresh" }
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
  replacementConnectionId: string | null;
}

interface PreparedSubmission extends SubmissionContext {
  fingerprint: string;
  preflightPlan: SetupPlan;
  credentialSource: SubmissionSource;
}

interface PersistedSubmission extends PreparedSubmission {
  providerCredentialId: string;
  connectionId: string;
  secretStore?: CredentialSecretStore;
  stored: StoredCredentialSecret;
}

class SetupConflict extends Error {
  constructor(
    readonly reason?: InstallationConflictReason,
    readonly connectionId?: string
  ) {
    super(
      reason === "unfinished_installation_exists"
        ? UNFINISHED_INSTALLATION_MESSAGE
        : REPLACEMENT_CONFLICT_MESSAGE
    );
  }
}

class SubmissionOutcomeUnknown extends Error {
  constructor(readonly responseError: unknown) {
    super("Provider credential submission outcome is unknown");
  }
}

export async function submitProviderCredential(
  c: Context<{ Bindings: Env }>,
  input: SubmitPrivyCredentialInput,
  idempotencyKey: string
): Promise<ProviderCredentialSubmissionResult> {
  return submitProviderCredentialIntent(c, input, idempotencyKey, null);
}

export async function replaceProviderCredential(
  c: Context<{ Bindings: Env }>,
  connectionId: string,
  input: StoredPrivyCredentialInput,
  idempotencyKey: string
): Promise<ProviderCredentialSubmissionResult> {
  return submitProviderCredentialIntent(c, input, idempotencyKey, connectionId);
}

async function submitProviderCredentialIntent(
  c: Context<{ Bindings: Env }>,
  input: SubmitPrivyCredentialInput,
  idempotencyKey: string,
  replacementConnectionId: string | null
): Promise<ProviderCredentialSubmissionResult> {
  const context = createSubmissionContext(c, input, idempotencyKey, replacementConnectionId);
  const replay = await loadReplay(context);
  if (replay) {
    const fingerprint = await computeSubmissionFingerprint(context);
    return resolveReplayWithAudit(context, replay, fingerprint);
  }

  const admission = await resolveSubmissionSource(context);
  if (admission.kind === "replay") {
    return admission.result;
  }
  const credentialSource = admission.source;
  const fingerprint = await computeSubmissionFingerprint(context);

  const setup = await prepareSetup(context, fingerprint);
  if (setup.kind === "replay") {
    return setup.result;
  }

  return persistPreparedSubmission({
    ...context,
    fingerprint,
    preflightPlan: setup.plan,
    credentialSource,
  });
}

function createSubmissionContext(
  c: Context<{ Bindings: Env }>,
  input: SubmitPrivyCredentialInput,
  idempotencyKey: string,
  replacementConnectionId: string | null
): SubmissionContext {
  const auth = getAuth(c);
  const organizationId = auth.organizationId;
  const projectId = requireProjectId(c);
  const userId = auth.userId;
  if (!userId) {
    throw internalError();
  }

  const db = getDb(c.env);
  const store = new ProviderCredentialStore(db);
  const audit = new AuditService(db);
  const auditBase = {
    organizationId,
    userId,
    provider: input.provider,
    scope: "project",
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
    replacementConnectionId,
  };
}

async function computeSubmissionFingerprint(context: SubmissionContext): Promise<string> {
  let pepper: string;
  try {
    pepper = requireEnv(
      {
        CREDENTIAL_FINGERPRINT_PEPPER: context.c.env.CREDENTIAL_FINGERPRINT_PEPPER,
      },
      "CREDENTIAL_FINGERPRINT_PEPPER"
    );
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
      replacementConnectionId: context.replacementConnectionId,
    });
  } catch {
    await auditFailure(context.c, context.audit, context.auditBase, {
      reason: "fingerprint_failed",
    });
    throw internalError();
  }
}

async function loadReplay(context: SubmissionContext): Promise<ProviderCredentialRow | null> {
  try {
    return await context.store.findReplayByKey(context.organizationId, context.idempotencyKey);
  } catch {
    await auditFailure(context.c, context.audit, context.auditBase, {
      reason: "database_failure",
    });
    throw internalError();
  }
}

async function resolveSubmissionSource(
  context: SubmissionContext
): Promise<
  | { kind: "source"; source: SubmissionSource }
  | { kind: "replay"; result: ProviderCredentialSubmissionResult }
> {
  const setupMethod = resolveNewCustodySetupMethod(context.c.env, context.input.provider);
  const source = context.replacementConnectionId
    ? "stored"
    : setupMethod === "deployment_credentials"
      ? "runtime"
      : setupMethod === "stored_credentials"
        ? "stored"
        : null;

  if (source) {
    if (source === "stored" && !context.input.fields) {
      throw badRequest("Credential fields are required for stored setup");
    }
    if (source === "runtime" && context.input.fields) {
      throw badRequest("Credential fields are not accepted for runtime setup");
    }
    if (
      await isPersistedCustodyCompletionEnabled(
        context.c.env,
        context.db,
        context.organizationId,
        "privy",
        source
      )
    ) {
      return { kind: "source", source };
    }
  }

  const replay = await loadReplay(context);
  if (replay) {
    return {
      kind: "replay",
      result: await resolveReplayWithAudit(
        context,
        replay,
        await computeSubmissionFingerprint(context)
      ),
    };
  }
  throw forbidden(PROVISIONING_DISABLED_MESSAGE);
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
      plan: await classifySetup(context),
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
      throw setupConflictResponse(error);
    }
    if (error instanceof AppError) {
      throw error;
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
  const auditIntent = await prepared.audit.beginCritical(prepared.c, {
    organizationId: prepared.organizationId,
    userId: prepared.userId,
    action: "submit",
    resourceType: "provider_credential",
    resourceId: providerCredentialId,
    metadata: {
      event: "provider_credential_submission_started",
      provider: prepared.input.provider,
      scope: "project",
      connectionId,
    },
  });

  try {
    let secretStore: CredentialSecretStore | undefined;
    let stored: StoredCredentialSecret;
    if (prepared.credentialSource === "stored") {
      secretStore = await createSubmissionSecretStore(prepared, providerCredentialId, connectionId);
      stored = await writeSubmissionSecret(
        prepared,
        providerCredentialId,
        connectionId,
        secretStore
      );
    } else {
      stored = { storageBackend: "runtime_env" };
    }

    const transaction = await commitSubmission({
      ...prepared,
      providerCredentialId,
      connectionId,
      ...(secretStore ? { secretStore } : {}),
      stored,
    });

    if (transaction.kind === "committed") {
      await prepared.audit.completeCritical(prepared.c, auditIntent, {
        metadata: {
          event: "provider_credential_submitted",
          storageBackend: stored.storageBackend,
          credentialStatus: transaction.result.providerCredential.status,
        },
      });
    } else {
      await closeSubmissionAuditIntent(
        prepared,
        auditIntent,
        "provider_credential_submission_replayed"
      );
    }
    return transaction.result;
  } catch (error) {
    if (error instanceof SubmissionOutcomeUnknown) {
      throw error.responseError;
    }
    await closeSubmissionAuditIntent(
      prepared,
      auditIntent,
      "provider_credential_submission_failed",
      "failure"
    );
    throw error;
  }
}

async function closeSubmissionAuditIntent(
  context: Pick<SubmissionContext, "c" | "audit">,
  intent: AuditIntent,
  event: string,
  status: "success" | "failure" = "success"
): Promise<void> {
  await context.audit.completeCritical(context.c, intent, {
    action: "maintenance",
    resourceType: "audit_ledger",
    resourceId: intent.id,
    status,
    metadata: { event },
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
  const fields = requireStoredFields(context.input);
  try {
    return await secretStore.write({
      orgId: context.organizationId,
      provider: context.input.provider,
      providerCredentialId,
      payload: {
        appId: fields.appId,
        appSecret: fields.appSecret,
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
    if (upstream) {
      throw new SubmissionOutcomeUnknown(
        providerUnavailable("Credential storage is temporarily unavailable")
      );
    }
    await auditFailure(context.c, context.audit, context.auditBase, {
      reason: "secret_store_failure",
      resourceId: providerCredentialId,
      connectionId,
      storageBackend: secretStore.storageBackend,
    });
    throw internalError();
  }
}

async function commitSubmission(submission: PersistedSubmission): Promise<TransactionResult> {
  let transactionResult: TransactionResult;
  try {
    transactionResult = await runSubmissionTransaction(submission);
  } catch (error) {
    return recoverTransactionFailure(submission, error);
  }

  if (transactionResult.kind === "replay" && submission.secretStore) {
    await compensateSecretWrite(
      submission.c,
      submission.secretStore,
      submission.stored,
      submission.providerCredentialId
    );
  }

  return transactionResult;
}

async function runSubmissionTransaction(
  submission: PersistedSubmission
): Promise<TransactionResult> {
  return submission.db.transaction(async (tx) => {
    const txStore = new ProviderCredentialStore(tx);
    if (!(await txStore.lockProject(submission.organizationId, submission.projectId))) {
      throw new Error("Project disappeared during credential submission");
    }

    const concurrentReplay = await txStore.findReplayByKey(
      submission.organizationId,
      submission.idempotencyKey
    );
    if (concurrentReplay) {
      return {
        kind: "replay",
        result: await resolveReplay(
          { ...submission, store: txStore },
          concurrentReplay,
          submission.fingerprint
        ),
      };
    }

    const lockedPlan = await classifySetup({ ...submission, store: txStore }, true);
    assertSameSetupPlan(submission.preflightPlan, lockedPlan);

    if (submission.credentialSource === "runtime" && lockedPlan.kind === "replacement") {
      throw new SetupConflict(undefined, lockedPlan.connection.id);
    }
    const fields =
      submission.credentialSource === "stored" ? requireStoredFields(submission.input) : null;
    const version =
      lockedPlan.kind === "replacement" ? lockedPlan.currentCredential.credential_version + 1 : 1;
    const rotatedFromId =
      lockedPlan.kind === "replacement" ? lockedPlan.currentCredential.id : null;
    const displayMetadata: Record<string, string> =
      fields && fields.appId.length > 4 ? { appIdSuffix: fields.appId.slice(-4) } : {};

    const providerCredential = await txStore.insertCredential({
      id: submission.providerCredentialId,
      organizationId: submission.organizationId,
      projectId: submission.projectId,
      label: fields?.credentialLabel ?? RUNTIME_CREDENTIAL_LABEL,
      scope: "project",
      source: submission.credentialSource,
      stored: submission.stored,
      displayMetadata,
      version,
      rotatedFromId,
      idempotencyKey: submission.idempotencyKey,
      idempotencyFingerprint: submission.fingerprint,
      createdBy: submission.userId,
    });
    await persistConnection(txStore, submission, lockedPlan, providerCredential);

    return {
      kind: "committed",
      result: mapSubmissionResult(providerCredential, submission.connectionId),
    };
  });
}

async function persistConnection(
  store: ProviderCredentialStore,
  submission: PersistedSubmission,
  lockedPlan: SetupPlan,
  providerCredential: ProviderCredentialRow
): Promise<void> {
  if (lockedPlan.kind !== "replacement") {
    await store.insertConnection({
      id: submission.connectionId,
      organizationId: submission.organizationId,
      projectId: submission.projectId,
      providerCredentialId: submission.providerCredentialId,
      providerCredentialScopeKey: providerCredential.scope_key,
      requestDelayMs: submission.input.requestDelayMs,
      pendingWalletLabel: submission.input.walletLabel,
      createdBy: submission.userId,
    });
    return;
  }

  const updated = await store.resetFailedConnection({
    id: lockedPlan.connection.id,
    expectedProviderCredentialId: lockedPlan.currentCredential.id,
    providerCredentialId: submission.providerCredentialId,
    providerCredentialScopeKey: providerCredential.scope_key,
    requestDelayMs: submission.input.requestDelayMs,
    pendingWalletLabel: submission.input.walletLabel,
  });
  if (!updated) {
    throw new SetupConflict(undefined, lockedPlan.connection.id);
  }
}

async function recoverTransactionFailure(
  submission: PersistedSubmission,
  error: unknown
): Promise<TransactionResult> {
  const reconciliation = await reconcileTransactionOutcome(submission);
  if (reconciliation.kind === "found") {
    if (reconciliation.replay.id === submission.providerCredentialId) {
      try {
        const committed = await resolveReplay(
          submission,
          reconciliation.replay,
          submission.fingerprint
        );
        return { kind: "committed", result: committed };
      } catch (replayError) {
        throw new SubmissionOutcomeUnknown(replayError);
      }
    }

    const compensationOutcome = await compensateSubmissionSecret(submission);
    return {
      kind: "replay",
      result: await resolveReplayWithAudit(
        submission,
        reconciliation.replay,
        submission.fingerprint,
        {
          failureResourceId: submission.providerCredentialId,
          compensationOutcome,
        }
      ),
    };
  }

  if (reconciliation.kind === "unknown") {
    reportManualSecretCleanupRequired(submission);
    throw new SubmissionOutcomeUnknown(internalError());
  }

  const compensationOutcome = await compensateSubmissionSecret(submission);

  if (error instanceof SetupConflict) {
    await auditFailure(submission.c, submission.audit, submission.auditBase, {
      reason: "setup_conflict",
      resourceId: submission.providerCredentialId,
      connectionId: error.connectionId ?? submission.connectionId,
      storageBackend: submission.stored.storageBackend,
      compensationOutcome,
    });
    throw setupConflictResponse(error);
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

  if (isUnfinishedInstallationUniqueViolation(error)) {
    const setupError = new SetupConflict("unfinished_installation_exists", submission.connectionId);
    await auditFailure(submission.c, submission.audit, submission.auditBase, {
      reason: "setup_conflict",
      resourceId: submission.providerCredentialId,
      connectionId: submission.connectionId,
      storageBackend: submission.stored.storageBackend,
      compensationOutcome,
    });
    throw setupConflictResponse(setupError);
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

function isUnfinishedInstallationUniqueViolation(error: unknown): boolean {
  return (
    isPostgresUniqueViolation(error) &&
    typeof error === "object" &&
    error !== null &&
    "constraint" in error &&
    error.constraint === "idx_custody_connections_privy_unfinished"
  );
}

async function reconcileTransactionOutcome(
  submission: PersistedSubmission
): Promise<
  { kind: "found"; replay: ProviderCredentialRow } | { kind: "absent" } | { kind: "unknown" }
> {
  try {
    const replay = await submission.store.findReplayByKey(
      submission.organizationId,
      submission.idempotencyKey
    );
    return replay ? { kind: "found", replay } : { kind: "absent" };
  } catch {
    return { kind: "unknown" };
  }
}

function reportManualSecretCleanupRequired(submission: PersistedSubmission): void {
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

async function compensateSubmissionSecret(
  submission: PersistedSubmission
): Promise<CompensationOutcome> {
  return submission.secretStore
    ? compensateSecretWrite(
        submission.c,
        submission.secretStore,
        submission.stored,
        submission.providerCredentialId
      )
    : "not_required";
}

async function buildProviderCredentialSubmissionFingerprint(params: {
  organizationId: string;
  projectId: string;
  input: SubmitPrivyCredentialInput;
  pepper: string;
  replacementConnectionId?: string | null;
}): Promise<string> {
  const canonical = JSON.stringify(
    normalizeForFingerprint({
      version: 1,
      operation: "provider_credential_submission",
      target: {
        organizationId: params.organizationId,
        projectId: params.projectId,
        ...(params.replacementConnectionId && {
          connectionId: params.replacementConnectionId,
        }),
      },
      provider: params.input.provider,
      requestDelayMs: params.input.requestDelayMs,
      walletLabel: params.input.walletLabel,
      fields: params.input.fields,
    })
  );
  return hashString(canonical, params.pepper);
}

function requireStoredFields(input: SubmitPrivyCredentialInput): PrivyCredentialFields {
  if (!input.fields) {
    throw internalError();
  }
  return input.fields;
}

async function resolveReplay(
  context: Pick<SubmissionContext, "store" | "organizationId" | "projectId">,
  replay: ProviderCredentialRow,
  fingerprint: string
): Promise<ProviderCredentialSubmissionResult> {
  await resolveIdempotencyReplay(async () => replay, fingerprint);
  const connectionIds = await context.store.findConnectionIdsForCredentialLineage(
    context.organizationId,
    context.projectId,
    replay.id
  );
  if (connectionIds.length !== 1) {
    throw internalError();
  }
  return mapSubmissionResult(replay, connectionIds[0] as string);
}

async function resolveReplayWithAudit(
  context: Pick<
    SubmissionContext,
    "c" | "audit" | "auditBase" | "store" | "organizationId" | "projectId"
  >,
  replay: ProviderCredentialRow,
  fingerprint: string,
  failure?: {
    failureResourceId?: string;
    compensationOutcome?: CompensationOutcome;
  }
): Promise<ProviderCredentialSubmissionResult> {
  try {
    return await resolveReplay(context, replay, fingerprint);
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
  let replay: ProviderCredentialRow | null;
  try {
    replay = await params.store.findReplayByKey(params.organizationId, params.idempotencyKey);
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
  context: Pick<
    SubmissionContext,
    "store" | "organizationId" | "projectId" | "replacementConnectionId"
  >,
  lock = false
): Promise<SetupPlan> {
  if (!context.replacementConnectionId) {
    const connections = await context.store.listProjectConnections(
      context.organizationId,
      context.projectId,
      { lock }
    );
    const unfinished = connections.find(
      (connection) => connection.status === "pending" || connection.status === "checking"
    );
    if (unfinished) {
      throw new SetupConflict("unfinished_installation_exists", unfinished.id);
    }
    return { kind: "fresh" };
  }

  const connection = await context.store.findInstallationConnection(
    context.organizationId,
    context.projectId,
    context.replacementConnectionId,
    { lock }
  );
  if (!connection) {
    throw notFound("Custody Connection");
  }
  const nowMs = await context.store.getDatabaseNowMs();
  const decision = decideInstallation(
    installationFactsFromConnection(connection, nowMs, true)
  ).replace;
  if (decision.kind !== "execute") {
    throw new SetupConflict(
      decision.kind === "conflict" ? decision.reason : undefined,
      connection.id
    );
  }

  const currentCredential = await context.store.findCredential(connection.provider_credential_id, {
    lock,
  });
  if (
    currentCredential?.status !== "failed_validation" ||
    currentCredential.credential_version !== connection.credential_version
  ) {
    throw new SetupConflict(undefined, connection.id);
  }

  return { kind: "replacement", connection, currentCredential };
}

function setupConflictResponse(error: SetupConflict): AppError {
  return conflict(error.message, error.reason ? { reason: error.reason } : undefined);
}

function assertSameSetupPlan(preflight: SetupPlan, locked: SetupPlan): void {
  if (preflight.kind !== locked.kind) {
    throw new SetupConflict(
      undefined,
      locked.kind === "replacement" ? locked.connection.id : undefined
    );
  }
  if (
    preflight.kind === "replacement" &&
    locked.kind === "replacement" &&
    (preflight.connection.id !== locked.connection.id ||
      preflight.currentCredential.id !== locked.currentCredential.id ||
      preflight.currentCredential.credential_version !==
        locked.currentCredential.credential_version)
  ) {
    throw new SetupConflict(undefined, locked.connection.id);
  }
}

function mapSubmissionResult(
  providerCredential: ProviderCredentialRow,
  connectionId: string
): ProviderCredentialSubmissionResult {
  return {
    providerCredential: mapProviderCredential(providerCredential),
    connectionId,
  };
}

export function mapProviderCredential(row: ProviderCredentialRow): SafeProviderCredential {
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
  getLogger().error(
    {
      providerCredentialId: params.providerCredentialId,
      provider: "privy",
      storageBackend: params.storageBackend,
      ...(params.providerResourceVersion !== undefined && {
        providerResourceVersion: params.providerResourceVersion,
      }),
      requestId: params.requestId,
      reason: params.reason,
    },
    "provider_credential_orphan_risk"
  );
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
