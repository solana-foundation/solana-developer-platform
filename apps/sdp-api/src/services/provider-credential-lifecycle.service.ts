import { hashString } from "@sdp/payments/hash";
import type { Context } from "hono";
import { getDb } from "@/db";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import { getAuth, requireProjectId } from "@/lib/auth";
import {
  AppError,
  conflict,
  forbidden,
  internalError,
  notFound,
  providerUnavailable,
} from "@/lib/errors";
import { normalizeForFingerprint, resolveIdempotencyReplay } from "@/lib/idempotency";
import { getLogger } from "@/runtime/logger";
import { describeError, logEvent } from "@/runtime/money-path-events";
import { type AuditIntent, AuditService } from "@/services/audit.service";
import {
  type CredentialSecretPayload,
  type CredentialSecretStore,
  CredentialSecretStoreError,
  createCredentialSecretStore,
  type StoredCredentialSecret,
} from "@/services/credential-secret-store";
import {
  checkPrivyCredential,
  getPrivyProviderAccountFingerprint,
  type PrivyCredentialAuthentication,
} from "@/services/custody/privy-credential";
import {
  mapProviderCredential,
  type SafeProviderCredential,
} from "@/services/provider-credential-submission.service";
import {
  type CredentialReferenceRow,
  type LifecycleCredentialRow,
  type LifecycleCredentialWithSecretRow,
  type ProviderCredentialRow,
  ProviderCredentialStore,
} from "@/services/stores/provider-credential.store";
import type { Env } from "@/types/env";

const ROTATION_UNAVAILABLE = "Credential rotation is not available";
const ROLLBACK_UNAVAILABLE = "Credential rollback is not available";
const CANDIDATE_UNAVAILABLE = "Credential cannot be deactivated from its current state";

export type RotationFailureCode = "invalid_credentials" | "provider_account_mismatch";

export interface ProviderCredentialLifecycle {
  providerCredential: LifecycleProviderCredential;
  rotationCandidate: LifecycleProviderCredential | null;
  impact: {
    projects: Array<{ id: string; name: string }>;
    connections: Array<{ id: string; projectId: string; status: string }>;
  };
  rollback: {
    providerCredential: LifecycleProviderCredential;
    expiresAt: string;
  } | null;
}

export interface LifecycleProviderCredential extends SafeProviderCredential {
  source: LifecycleCredentialRow["source"];
}

export interface ProviderCredentialRotationResult {
  providerCredential: SafeProviderCredential;
  rotation:
    | { status: "success" }
    | { status: "failed"; code: RotationFailureCode }
    | { status: "retry_unknown"; code: "provider_response_unknown" };
}

interface LifecycleContext {
  c: Context<{ Bindings: Env }>;
  organizationId: string;
  projectId: string;
  userId: string;
  store: ProviderCredentialStore;
  audit: AuditService;
}

interface AuthorizedCredential {
  credential: LifecycleCredentialRow;
  references: CredentialReferenceRow[];
}

export async function getProviderCredentialLifecycle(
  c: Context<{ Bindings: Env }>,
  connectionId: string
): Promise<ProviderCredentialLifecycle> {
  const context = createContext(c);
  const credentialId = await context.store.findLifecycleConnectionCredentialId(
    context.organizationId,
    context.projectId,
    connectionId
  );
  if (!credentialId) throw notFound("Custody Connection");

  const authorized = await loadAuthorizedCredential(context, credentialId);
  const candidate =
    authorized.credential.status === "active"
      ? await context.store.findPendingDirectChild(context.organizationId, authorized.credential.id)
      : null;
  const rollback = await loadRollbackTarget(context, authorized.credential);

  return {
    providerCredential: mapLifecycleCredential(authorized.credential),
    rotationCandidate: candidate ? mapLifecycleCredential(candidate) : null,
    impact: projectImpact(authorized.references),
    rollback: rollback
      ? {
          providerCredential: mapLifecycleCredential(rollback),
          expiresAt: rollback.secret_retention_expires_at as string,
        }
      : null,
  };
}

export async function rotateProviderCredential(
  c: Context<{ Bindings: Env }>,
  currentCredentialId: string,
  fields: { appId: string; appSecret: string },
  idempotencyKey: string
): Promise<ProviderCredentialRotationResult> {
  const context = createContext(c);
  const target = await loadAuthorizedCredential(context, currentCredentialId);
  const fingerprint = await rotationFingerprint(context, currentCredentialId, fields);
  const existing = await context.store.findReplayByKey(context.organizationId, idempotencyKey);
  if (existing) {
    if (existing.rotated_from_provider_credential_id !== target.credential.id) {
      throw conflict(ROTATION_UNAVAILABLE);
    }
    const authorizedReplay = await loadAuthorizedCandidate(context, existing.id, true);
    const replay = await resolveIdempotencyReplay(() => Promise.resolve(existing), fingerprint);
    if (replay) return replayRotationCandidate(c, authorizedReplay);
  }
  const current = await loadAuthorizedCurrent(context, currentCredentialId, ROTATION_UNAVAILABLE);
  if (await context.store.findPendingDirectChild(context.organizationId, current.credential.id)) {
    throw conflict(ROTATION_UNAVAILABLE);
  }

  const candidateId = `pcred_${crypto.randomUUID()}`;
  const secretStore = createStoredSecretStore(c, candidateId);
  const stored = await writeRotationSecret(
    context,
    secretStore,
    candidateId,
    fields.appId,
    fields.appSecret
  );

  let candidate: LifecycleCredentialRow;
  try {
    const transaction = await getDb(c.env).transaction(async (tx) => {
      const store = new ProviderCredentialStore(tx);
      await assertLockedAuthorization(context, store, current.references);
      const lockedReferences = await store.listCredentialReferences(
        context.organizationId,
        current.credential.id,
        { lock: true }
      );
      const lockedCurrent = await store.findLifecycleCredential(
        context.organizationId,
        current.credential.id,
        { lock: true }
      );
      assertCurrentSnapshot(lockedCurrent, lockedReferences, current, ROTATION_UNAVAILABLE);

      const concurrentReplay = await resolveIdempotencyReplay(async () => {
        const row = await store.findReplayByKey(context.organizationId, idempotencyKey);
        if (row && row.rotated_from_provider_credential_id !== current.credential.id) {
          throw conflict(ROTATION_UNAVAILABLE);
        }
        return row;
      }, fingerprint);
      if (concurrentReplay) return { kind: "replay" as const, id: concurrentReplay.id };
      if (
        await store.findPendingDirectChild(context.organizationId, current.credential.id, {
          lock: true,
        })
      ) {
        throw conflict(ROTATION_UNAVAILABLE);
      }

      const inserted = await store.insertCredential({
        id: candidateId,
        organizationId: context.organizationId,
        projectId: current.credential.project_id,
        provider: "privy",
        label: current.credential.label,
        scope: current.credential.scope,
        source: "stored",
        stored,
        displayMetadata: fields.appId.length > 4 ? { appIdSuffix: fields.appId.slice(-4) } : {},
        version: current.credential.credential_version + 1,
        rotatedFromId: current.credential.id,
        idempotencyKey,
        idempotencyFingerprint: fingerprint,
        createdBy: context.userId,
      });
      return { kind: "committed" as const, id: inserted.id };
    });
    if (transaction.kind === "replay" && transaction.id !== candidateId) {
      await compensateSecretWrite(c, secretStore, stored, candidateId);
    }
    const loaded = await context.store.findLifecycleCredential(
      context.organizationId,
      transaction.id
    );
    if (!loaded) throw internalError();
    candidate = loaded;
  } catch (error) {
    let recovered: ProviderCredentialRow | null;
    try {
      recovered = await context.store.findReplayByKey(context.organizationId, idempotencyKey);
    } catch (reconciliationError) {
      logLifecycleFailure(c, "candidate_insert_reconcile", candidateId, reconciliationError);
      logSecretWriteOutcomeUnknown(c, candidateId, stored.storageBackend);
      throw error;
    }
    if (recovered?.idempotency_fingerprint === fingerprint) {
      if (recovered.id !== candidateId) {
        await compensateSecretWrite(c, secretStore, stored, candidateId);
      }
      return completeRotationCandidate(c, recovered.id);
    }
    await compensateSecretWrite(c, secretStore, stored, candidateId);
    if (isPostgresUniqueViolation(error)) throw conflict(ROTATION_UNAVAILABLE);
    throw error;
  }

  return completeRotationCandidate(c, candidate.id);
}

export async function completeRotationCandidate(
  c: Context<{ Bindings: Env }>,
  candidateId: string
): Promise<ProviderCredentialRotationResult> {
  const context = createContext(c);
  const loaded = await loadAuthorizedCandidate(context, candidateId);
  if (loaded.candidate.status === "active") {
    return rotationResult(loaded.candidate, "success");
  }
  if (loaded.candidate.status === "failed_validation") {
    const code = safeRotationFailureCode(loaded.candidate.last_failure_code);
    if (!code) throw conflict(ROTATION_UNAVAILABLE);
    return rotationResult(loaded.candidate, "failed", code);
  }
  if (loaded.candidate.status !== "pending") throw conflict(ROTATION_UNAVAILABLE);
  if (loaded.references.length === 0 || loaded.candidateReferences.length > 0) {
    throw conflict(ROTATION_UNAVAILABLE);
  }

  let candidateSecret: LifecycleCredentialWithSecretRow;
  let authentication: PrivyCredentialAuthentication;
  try {
    candidateSecret = await requireLifecycleCredentialSecret(context, loaded.candidate.id);
    const secretStore = createPersistedSecretStore(c, candidateSecret.storage_backend, candidateId);
    authentication = await readPrivyCredential(secretStore, context, candidateSecret);
  } catch (error) {
    return reconcileCandidateSecretReadFailure(c, context, loaded.candidate.id, error);
  }
  const check = await checkPrivyCredential(c.env, authentication);
  if (check === "retry_unknown") {
    const race = await settleCandidateOutcome(context, loaded, "retry_unknown");
    if (race) return race;
    return rotationResult(loaded.candidate, "retry_unknown", "provider_response_unknown");
  }

  const accountMatches =
    check === "success" &&
    (await continuityFingerprint(authentication.appId)) ===
      uniqueReferenceFingerprint(loaded.references);
  if (check === "failed" || !accountMatches) {
    const code: RotationFailureCode =
      check === "failed" ? "invalid_credentials" : "provider_account_mismatch";
    const race = await settleCandidateOutcome(context, loaded, code);
    if (race?.rotation.status === "success") return race;
    await cleanupRejectedCandidate(c, candidateSecret);
    if (race) return race;
    return rotationResult({ ...loaded.candidate, status: "failed_validation" }, "failed", code);
  }

  const auditIntent = await context.audit.beginCritical(c, {
    organizationId: context.organizationId,
    userId: context.userId,
    action: "rotate",
    resourceType: "provider_credential",
    resourceId: loaded.candidate.id,
    metadata: { event: "provider_credential_rotation_started", provider: "privy" },
  });
  let applied = false;
  try {
    await getDb(c.env).transaction(async (tx) => {
      const store = new ProviderCredentialStore(tx);
      await assertLockedAuthorization(context, store, loaded.references);
      const lockedReferences = await store.listCredentialReferences(
        context.organizationId,
        loaded.predecessor.id,
        { lock: true }
      );
      const lockedCandidateReferences = await store.listCredentialReferences(
        context.organizationId,
        loaded.candidate.id,
        { lock: true }
      );
      const lockedCandidate = await store.findLifecycleCredential(
        context.organizationId,
        loaded.candidate.id,
        { lock: true }
      );
      const lockedPredecessor = await store.findLifecycleCredential(
        context.organizationId,
        loaded.predecessor.id,
        { lock: true }
      );
      assertCandidateSnapshot(lockedCandidate, lockedPredecessor, lockedReferences, loaded);
      if (lockedCandidateReferences.length > 0) throw conflict(ROTATION_UNAVAILABLE);
      const changed = await store.cutOverRotation({
        organizationId: context.organizationId,
        predecessorId: loaded.predecessor.id,
        candidateId: loaded.candidate.id,
        candidateScopeKey: loaded.candidate.scope_key,
        expectedConnectionIds: referenceIds(loaded.references),
      });
      if (!changed) {
        throw conflict(ROTATION_UNAVAILABLE);
      }
      applied = true;
    });
  } catch (error) {
    logLifecycleFailure(c, "rotation_commit", loaded.candidate.id, error);
    const visible = await rotationCommitIsVisible(context, loaded);
    if (visible === true) {
      if (applied) {
        logUnresolvedAuditIntent(context, auditIntent, loaded.candidate.id);
      } else {
        await closeRejectedIntent(context, auditIntent, "provider_credential_rotation_replayed");
        await loadAuthorizedCandidate(context, loaded.candidate.id);
      }
      return rotationResult({ ...loaded.candidate, status: "active" }, "success");
    }
    if (applied || visible === null) {
      throw providerUnavailable("Credential rotation outcome is temporarily unknown");
    }
    await closeRejectedIntent(context, auditIntent, "provider_credential_rotation_not_committed");
    if (error instanceof AppError) throw error;
    throw conflict(ROTATION_UNAVAILABLE);
  }
  await context.audit.completeCritical(c, auditIntent, {
    metadata: { event: "provider_credential_rotated", provider: "privy" },
  });
  return rotationResult({ ...loaded.candidate, status: "active" }, "success");
}

export async function rollbackProviderCredential(
  c: Context<{ Bindings: Env }>,
  currentCredentialId: string
): Promise<{ providerCredential: SafeProviderCredential }> {
  const context = createContext(c);
  const current = await loadAuthorizedCurrent(context, currentCredentialId, ROLLBACK_UNAVAILABLE);
  if (await context.store.findPendingDirectChild(context.organizationId, current.credential.id)) {
    throw conflict(ROLLBACK_UNAVAILABLE);
  }
  const predecessor = await loadRollbackTarget(context, current.credential);
  if (!predecessor) throw conflict(ROLLBACK_UNAVAILABLE);

  let authentication: PrivyCredentialAuthentication;
  try {
    const predecessorSecret = await requireLifecycleCredentialSecret(context, predecessor.id);
    const secretStore = createPersistedSecretStore(
      c,
      predecessorSecret.storage_backend,
      predecessor.id
    );
    authentication = await readPrivyCredential(secretStore, context, predecessorSecret);
  } catch (error) {
    const refreshedCurrent = await loadAuthorizedCurrent(
      context,
      currentCredentialId,
      ROLLBACK_UNAVAILABLE
    );
    const refreshedPredecessor = await loadRollbackTarget(context, refreshedCurrent.credential);
    if (
      refreshedPredecessor?.id !== predecessor.id ||
      !sameReferences(refreshedCurrent.references, current.references)
    ) {
      throw conflict(ROLLBACK_UNAVAILABLE);
    }
    throw error;
  }
  const check = await checkPrivyCredential(c.env, authentication);
  if (check === "retry_unknown") {
    throw providerUnavailable("Credential provider is temporarily unavailable");
  }
  if (
    check === "failed" ||
    (await continuityFingerprint(authentication.appId)) !==
      uniqueReferenceFingerprint(current.references)
  ) {
    throw conflict(ROLLBACK_UNAVAILABLE);
  }

  const auditIntent = await context.audit.beginCritical(c, {
    organizationId: context.organizationId,
    userId: context.userId,
    action: "rollback",
    resourceType: "provider_credential",
    resourceId: predecessor.id,
    metadata: { event: "provider_credential_rollback_started", provider: "privy" },
  });
  let applied = false;
  try {
    await getDb(c.env).transaction(async (tx) => {
      const store = new ProviderCredentialStore(tx);
      await assertLockedAuthorization(context, store, current.references);
      const lockedReferences = await store.listCredentialReferences(
        context.organizationId,
        current.credential.id,
        { lock: true }
      );
      const lockedCurrent = await store.findLifecycleCredential(
        context.organizationId,
        current.credential.id,
        { lock: true }
      );
      const lockedPredecessor = await store.findLifecycleCredential(
        context.organizationId,
        predecessor.id,
        { lock: true }
      );
      assertRollbackSnapshot(lockedCurrent, lockedPredecessor, lockedReferences, current);
      if (
        await store.findPendingDirectChild(context.organizationId, current.credential.id, {
          lock: true,
        })
      ) {
        throw conflict(ROLLBACK_UNAVAILABLE);
      }
      const changed = await store.rollBackCredential({
        organizationId: context.organizationId,
        currentId: current.credential.id,
        predecessorId: predecessor.id,
        predecessorScopeKey: predecessor.scope_key,
        expectedConnectionIds: referenceIds(current.references),
      });
      if (!changed) {
        throw conflict(ROLLBACK_UNAVAILABLE);
      }
      applied = true;
    });
  } catch (error) {
    logLifecycleFailure(c, "rollback_commit", currentCredentialId, error);
    const visible = await rollbackCommitIsVisible(context, current, predecessor);
    if (visible === true) {
      if (applied) {
        logUnresolvedAuditIntent(context, auditIntent, predecessor.id);
      } else {
        await closeRejectedIntent(context, auditIntent, "provider_credential_rollback_replayed");
        await loadAuthorizedCurrent(context, predecessor.id, ROLLBACK_UNAVAILABLE);
      }
      return {
        providerCredential: mapProviderCredential({ ...predecessor, status: "active" }),
      };
    }
    if (applied || visible === null) {
      throw providerUnavailable("Credential rollback outcome is temporarily unknown");
    }
    await closeRejectedIntent(context, auditIntent, "provider_credential_rollback_not_committed");
    if (error instanceof AppError) throw error;
    throw conflict(ROLLBACK_UNAVAILABLE);
  }
  await context.audit.completeCritical(c, auditIntent, {
    metadata: { event: "provider_credential_rolled_back", provider: "privy" },
  });
  return {
    providerCredential: mapProviderCredential({ ...predecessor, status: "active" }),
  };
}

export async function deactivateRotationCandidate(
  c: Context<{ Bindings: Env }>,
  candidateId: string
): Promise<{ providerCredential: SafeProviderCredential }> {
  const context = createContext(c);
  const loaded = await loadAuthorizedCandidate(context, candidateId, true, CANDIDATE_UNAVAILABLE);
  if (loaded.candidate.status === "deactivated") {
    const candidateSecret = await requireLifecycleCredentialSecret(context, candidateId);
    await cleanupRejectedCandidate(c, candidateSecret);
    return { providerCredential: mapProviderCredential(loaded.candidate) };
  }
  if (loaded.candidate.status !== "pending" || loaded.candidateReferences.length > 0) {
    throw conflict(CANDIDATE_UNAVAILABLE);
  }
  if (loaded.references.length === 0) throw conflict(CANDIDATE_UNAVAILABLE);
  const candidateSecret = await requireLifecycleCredentialSecret(context, candidateId);

  const auditIntent = await context.audit.beginCritical(c, {
    organizationId: context.organizationId,
    userId: context.userId,
    action: "deactivate",
    resourceType: "provider_credential",
    resourceId: loaded.candidate.id,
    metadata: { event: "provider_credential_rotation_cancellation_started", provider: "privy" },
  });
  let applied = false;
  try {
    await getDb(c.env).transaction(async (tx) => {
      const store = new ProviderCredentialStore(tx);
      await assertLockedAuthorization(context, store, loaded.references);
      const lockedReferences = await store.listCredentialReferences(
        context.organizationId,
        loaded.predecessor.id,
        { lock: true }
      );
      const lockedCandidateReferences = await store.listCredentialReferences(
        context.organizationId,
        loaded.candidate.id,
        { lock: true }
      );
      const lockedCandidate = await store.findLifecycleCredential(
        context.organizationId,
        loaded.candidate.id,
        { lock: true }
      );
      const lockedPredecessor = await store.findLifecycleCredential(
        context.organizationId,
        loaded.predecessor.id,
        { lock: true }
      );
      assertCandidateSnapshot(
        lockedCandidate,
        lockedPredecessor,
        lockedReferences,
        loaded,
        CANDIDATE_UNAVAILABLE
      );
      if (lockedCandidateReferences.length > 0) throw conflict(CANDIDATE_UNAVAILABLE);
      const changed = await store.deactivateRotationCandidate({
        organizationId: context.organizationId,
        candidateId: loaded.candidate.id,
        predecessorId: loaded.predecessor.id,
      });
      if (!changed) {
        throw conflict(CANDIDATE_UNAVAILABLE);
      }
      applied = true;
    });
  } catch (error) {
    logLifecycleFailure(c, "cancellation_commit", candidateId, error);
    const visible = await cancellationCommitIsVisible(context, loaded);
    if (visible === true) {
      if (applied) {
        logUnresolvedAuditIntent(context, auditIntent, candidateId);
      } else {
        await closeRejectedIntent(
          context,
          auditIntent,
          "provider_credential_rotation_cancellation_replayed"
        );
        await loadAuthorizedCandidate(context, loaded.candidate.id, true, CANDIDATE_UNAVAILABLE);
      }
      await cleanupRejectedCandidate(c, candidateSecret);
      return {
        providerCredential: mapProviderCredential({ ...loaded.candidate, status: "deactivated" }),
      };
    }
    if (applied || visible === null) {
      throw providerUnavailable("Credential cancellation outcome is temporarily unknown");
    }
    await closeRejectedIntent(
      context,
      auditIntent,
      "provider_credential_rotation_cancellation_not_committed"
    );
    if (error instanceof AppError) throw error;
    throw conflict(CANDIDATE_UNAVAILABLE);
  }
  await cleanupRejectedCandidate(c, candidateSecret);
  await context.audit.completeCritical(c, auditIntent, {
    metadata: { event: "provider_credential_rotation_canceled", provider: "privy" },
  });
  return {
    providerCredential: mapProviderCredential({ ...loaded.candidate, status: "deactivated" }),
  };
}

function createContext(c: Context<{ Bindings: Env }>): LifecycleContext {
  const auth = getAuth(c);
  const projectId = requireProjectId(c);
  if (!auth.userId) throw internalError();
  const db = getDb(c.env);
  return {
    c,
    organizationId: auth.organizationId,
    projectId,
    userId: auth.userId,
    store: new ProviderCredentialStore(db),
    audit: new AuditService(db),
  };
}

async function loadAuthorizedCredential(
  context: LifecycleContext,
  credentialId: string
): Promise<AuthorizedCredential> {
  const credential = await requireLifecycleCredential(context, credentialId);
  if (credential.scope === "project" && credential.project_id !== context.projectId) {
    throw notFound("Provider Credential");
  }
  const references = await context.store.listCredentialReferences(
    context.organizationId,
    credential.id
  );
  await assertAuthorization(context, references);
  return { credential, references };
}

async function loadAuthorizedCurrent(
  context: LifecycleContext,
  credentialId: string,
  unavailableMessage: string
): Promise<AuthorizedCredential> {
  const authorized = await loadAuthorizedCredential(context, credentialId);
  if (
    authorized.credential.status !== "active" ||
    authorized.credential.source !== "stored" ||
    authorized.references.length === 0
  ) {
    throw conflict(unavailableMessage);
  }
  return authorized;
}

async function loadAuthorizedCandidate(
  context: LifecycleContext,
  candidateId: string,
  allowHistorical = false,
  unavailableMessage = ROTATION_UNAVAILABLE
): Promise<{
  candidate: LifecycleCredentialRow;
  predecessor: LifecycleCredentialRow;
  references: CredentialReferenceRow[];
  candidateReferences: CredentialReferenceRow[];
}> {
  const candidate = await requireLifecycleCredential(context, candidateId);
  if (candidate.scope === "project" && candidate.project_id !== context.projectId) {
    throw notFound("Provider Credential");
  }
  if (!candidate.rotated_from_provider_credential_id || candidate.source !== "stored") {
    throw conflict(unavailableMessage);
  }
  const predecessor = await requireLifecycleCredential(
    context,
    candidate.rotated_from_provider_credential_id
  );
  const candidateReferences = await context.store.listCredentialReferences(
    context.organizationId,
    candidate.id
  );
  const references =
    candidate.status === "active"
      ? candidateReferences
      : predecessor.status === "active"
        ? await context.store.listCredentialReferences(context.organizationId, predecessor.id)
        : await context.store.listCredentialLineageReferences(context.organizationId, candidate.id);
  await assertAuthorization(context, [...references, ...candidateReferences]);
  if (!allowHistorical && candidate.status !== "active" && predecessor.status !== "active") {
    throw conflict(unavailableMessage);
  }
  return { candidate, predecessor, references, candidateReferences };
}

async function replayRotationCandidate(
  c: Context<{ Bindings: Env }>,
  loaded: Awaited<ReturnType<typeof loadAuthorizedCandidate>>
): Promise<ProviderCredentialRotationResult> {
  const candidate = loaded.candidate;
  if (candidate.status === "pending") return completeRotationCandidate(c, candidate.id);
  if (
    (candidate.status === "active" || candidate.status === "retired") &&
    candidate.last_validated_at
  ) {
    return rotationResult(candidate, "success");
  }
  if (candidate.status === "failed_validation") {
    const code = safeRotationFailureCode(candidate.last_failure_code);
    if (code) return rotationResult(candidate, "failed", code);
  }
  throw conflict(ROTATION_UNAVAILABLE);
}

async function reconcileCandidateSecretReadFailure(
  c: Context<{ Bindings: Env }>,
  context: LifecycleContext,
  candidateId: string,
  error: unknown
): Promise<ProviderCredentialRotationResult> {
  const current = await loadAuthorizedCandidate(context, candidateId, true);
  if (current.candidate.status !== "pending") return replayRotationCandidate(c, current);
  throw error;
}

async function requireLifecycleCredential(
  context: LifecycleContext,
  credentialId: string
): Promise<LifecycleCredentialRow> {
  const row = await context.store.findLifecycleCredential(context.organizationId, credentialId);
  if (!row) throw notFound("Provider Credential");
  return row;
}

async function requireLifecycleCredentialSecret(
  context: LifecycleContext,
  credentialId: string
): Promise<LifecycleCredentialWithSecretRow> {
  const row = await context.store.findLifecycleCredentialWithSecret(
    context.organizationId,
    credentialId
  );
  if (!row) throw notFound("Provider Credential");
  return row;
}

async function assertAuthorization(
  context: LifecycleContext,
  references: readonly CredentialReferenceRow[]
): Promise<void> {
  if (
    !(await context.store.lockAuthorizedProjects(
      context.organizationId,
      context.userId,
      references.map((reference) => reference.project_id)
    ))
  ) {
    throw forbidden("Requested project is not accessible");
  }
}

async function assertLockedAuthorization(
  context: LifecycleContext,
  store: ProviderCredentialStore,
  references: readonly CredentialReferenceRow[]
): Promise<void> {
  if (
    references.length === 0 ||
    !(await store.lockAuthorizedProjects(
      context.organizationId,
      context.userId,
      references.map((reference) => reference.project_id)
    ))
  ) {
    throw forbidden("Requested project is not accessible");
  }
}

async function loadRollbackTarget(
  context: LifecycleContext,
  current: LifecycleCredentialRow
): Promise<LifecycleCredentialRow | null> {
  if (current.status !== "active" || !current.rotated_from_provider_credential_id) return null;
  const predecessor = await context.store.findLifecycleCredential(
    context.organizationId,
    current.rotated_from_provider_credential_id
  );
  if (
    predecessor?.status !== "retired" ||
    predecessor.source !== "stored" ||
    !predecessor.secret_retention_expires_at ||
    Date.parse(predecessor.secret_retention_expires_at) <= (await context.store.getDatabaseNowMs())
  ) {
    return null;
  }
  return predecessor;
}

async function settleCandidateOutcome(
  context: LifecycleContext,
  expected: Awaited<ReturnType<typeof loadAuthorizedCandidate>>,
  outcome: "retry_unknown" | RotationFailureCode
): Promise<ProviderCredentialRotationResult | null> {
  const auditIntent =
    outcome === "retry_unknown"
      ? null
      : await context.audit.beginCritical(context.c, {
          organizationId: context.organizationId,
          userId: context.userId,
          action: "rotate",
          resourceType: "provider_credential",
          resourceId: expected.candidate.id,
          metadata: { event: "provider_credential_rotation_rejection_started", provider: "privy" },
        });
  let applied = false;
  try {
    await getDb(context.c.env).transaction(async (tx) => {
      const store = new ProviderCredentialStore(tx);
      await assertLockedAuthorization(context, store, expected.references);
      const lockedReferences = await store.listCredentialReferences(
        context.organizationId,
        expected.predecessor.id,
        { lock: true }
      );
      const lockedCandidateReferences = await store.listCredentialReferences(
        context.organizationId,
        expected.candidate.id,
        { lock: true }
      );
      const lockedCandidate = await store.findLifecycleCredential(
        context.organizationId,
        expected.candidate.id,
        { lock: true }
      );
      const lockedPredecessor = await store.findLifecycleCredential(
        context.organizationId,
        expected.predecessor.id,
        { lock: true }
      );
      assertCandidateSnapshot(lockedCandidate, lockedPredecessor, lockedReferences, expected);
      if (lockedCandidateReferences.length > 0) throw conflict(ROTATION_UNAVAILABLE);
      const persisted =
        outcome === "retry_unknown"
          ? await store.recordRotationRetryUnknown(expected.candidate.id)
          : await store.recordRotationFailure(expected.candidate.id, outcome);
      if (!persisted) throw conflict(ROTATION_UNAVAILABLE);
      applied = true;
    });
  } catch (error) {
    logLifecycleFailure(context.c, "candidate_outcome_write", expected.candidate.id, error);
    let current: Awaited<ReturnType<typeof loadAuthorizedCandidate>>;
    try {
      current = await loadAuthorizedCandidate(context, expected.candidate.id);
    } catch (reconciliationError) {
      logLifecycleFailure(
        context.c,
        "candidate_outcome_read",
        expected.candidate.id,
        reconciliationError
      );
      if (reconciliationError instanceof AppError) throw reconciliationError;
      throw providerUnavailable("Credential rotation outcome is temporarily unknown");
    }
    if (
      auditIntent &&
      (!applied ||
        current.candidate.status !== "failed_validation" ||
        current.candidate.last_failure_code !== outcome)
    ) {
      await closeRejectedIntent(
        context,
        auditIntent,
        "provider_credential_rotation_rejection_not_committed"
      );
    }
    // A failed COMMIT followed by the expected state does not prove which
    // concurrent request wrote it. Keep that intent unresolved, not a duplicate outcome.
    if (
      outcome === "retry_unknown" &&
      current.candidate.status === "pending" &&
      current.candidate.last_failure_code === "provider_response_unknown"
    ) {
      return null;
    }
    if (current.candidate.status === "active") {
      return rotationResult(current.candidate, "success");
    }
    if (current.candidate.status === "failed_validation") {
      const code = safeRotationFailureCode(current.candidate.last_failure_code);
      if (code) return rotationResult(current.candidate, "failed", code);
    }
    if (error instanceof AppError) throw error;
    throw providerUnavailable("Credential rotation outcome is temporarily unknown");
  }
  if (auditIntent) {
    await context.audit.completeCritical(context.c, auditIntent, {
      status: "failure",
      metadata: {
        event: "provider_credential_rotation_rejected",
        provider: "privy",
        failureCode: outcome,
      },
    });
  }
  return null;
}

function projectImpact(
  references: readonly CredentialReferenceRow[]
): ProviderCredentialLifecycle["impact"] {
  return {
    projects: [
      ...new Map(
        references.map((row) => [row.project_id, { id: row.project_id, name: row.project_name }])
      ).values(),
    ],
    connections: references.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      status: row.status,
    })),
  };
}

function referenceIds(references: readonly CredentialReferenceRow[]): string[] {
  return references.map((reference) => reference.id).sort();
}

function sameReferences(
  left: readonly CredentialReferenceRow[],
  right: readonly CredentialReferenceRow[]
): boolean {
  return (
    JSON.stringify(
      left.map((row) => [row.id, row.project_id, row.status, row.provider_account_fingerprint])
    ) ===
    JSON.stringify(
      right.map((row) => [row.id, row.project_id, row.status, row.provider_account_fingerprint])
    )
  );
}

function assertCurrentSnapshot(
  lockedCredential: LifecycleCredentialRow | null,
  lockedReferences: CredentialReferenceRow[],
  expected: AuthorizedCredential,
  message: string
): asserts lockedCredential is LifecycleCredentialRow {
  if (
    lockedCredential?.status !== "active" ||
    lockedCredential.id !== expected.credential.id ||
    !sameReferences(lockedReferences, expected.references)
  ) {
    throw conflict(message);
  }
}

function assertCandidateSnapshot(
  candidate: LifecycleCredentialRow | null,
  predecessor: LifecycleCredentialRow | null,
  references: CredentialReferenceRow[],
  expected: {
    candidate: LifecycleCredentialRow;
    predecessor: LifecycleCredentialRow;
    references: CredentialReferenceRow[];
  },
  unavailableMessage = ROTATION_UNAVAILABLE
): void {
  if (
    !candidate ||
    !predecessor ||
    candidate.status !== "pending" ||
    predecessor.status !== "active" ||
    candidate.rotated_from_provider_credential_id !== predecessor.id ||
    !sameReferences(references, expected.references)
  ) {
    throw conflict(unavailableMessage);
  }
}

function assertRollbackSnapshot(
  current: LifecycleCredentialRow | null,
  predecessor: LifecycleCredentialRow | null,
  references: CredentialReferenceRow[],
  expected: AuthorizedCredential
): void {
  if (
    !current ||
    !predecessor ||
    current.status !== "active" ||
    current.rotated_from_provider_credential_id !== predecessor.id ||
    predecessor.status !== "retired" ||
    !predecessor.secret_retention_expires_at ||
    !sameReferences(references, expected.references)
  ) {
    throw conflict(ROLLBACK_UNAVAILABLE);
  }
}

async function rotationCommitIsVisible(
  context: LifecycleContext,
  expected: Awaited<ReturnType<typeof loadAuthorizedCandidate>>
): Promise<boolean | null> {
  try {
    const [candidate, predecessor, candidateReferences, predecessorReferences] = await Promise.all([
      context.store.findLifecycleCredential(context.organizationId, expected.candidate.id),
      context.store.findLifecycleCredential(context.organizationId, expected.predecessor.id),
      context.store.listCredentialReferences(context.organizationId, expected.candidate.id),
      context.store.listCredentialReferences(context.organizationId, expected.predecessor.id),
    ]);
    return (
      candidate?.status === "active" &&
      predecessor?.status === "retired" &&
      predecessorReferences.length === 0 &&
      JSON.stringify(referenceIds(candidateReferences)) ===
        JSON.stringify(referenceIds(expected.references))
    );
  } catch (error) {
    logLifecycleFailure(context.c, "rotation_outcome_read", expected.candidate.id, error);
    return null;
  }
}

async function rollbackCommitIsVisible(
  context: LifecycleContext,
  expected: AuthorizedCredential,
  predecessor: LifecycleCredentialRow
): Promise<boolean | null> {
  try {
    const [current, restored, currentReferences, restoredReferences] = await Promise.all([
      context.store.findLifecycleCredential(context.organizationId, expected.credential.id),
      context.store.findLifecycleCredential(context.organizationId, predecessor.id),
      context.store.listCredentialReferences(context.organizationId, expected.credential.id),
      context.store.listCredentialReferences(context.organizationId, predecessor.id),
    ]);
    return (
      current?.status === "retired" &&
      restored?.status === "active" &&
      currentReferences.length === 0 &&
      JSON.stringify(referenceIds(restoredReferences)) ===
        JSON.stringify(referenceIds(expected.references))
    );
  } catch (error) {
    logLifecycleFailure(context.c, "rollback_outcome_read", expected.credential.id, error);
    return null;
  }
}

async function cancellationCommitIsVisible(
  context: LifecycleContext,
  expected: Awaited<ReturnType<typeof loadAuthorizedCandidate>>
): Promise<boolean | null> {
  try {
    const [candidate, predecessor, candidateReferences, predecessorReferences] = await Promise.all([
      context.store.findLifecycleCredential(context.organizationId, expected.candidate.id),
      context.store.findLifecycleCredential(context.organizationId, expected.predecessor.id),
      context.store.listCredentialReferences(context.organizationId, expected.candidate.id),
      context.store.listCredentialReferences(context.organizationId, expected.predecessor.id),
    ]);
    return (
      candidate?.status === "deactivated" &&
      predecessor?.status === "active" &&
      candidateReferences.length === 0 &&
      sameReferences(predecessorReferences, expected.references)
    );
  } catch (error) {
    logLifecycleFailure(context.c, "cancellation_outcome_read", expected.candidate.id, error);
    return null;
  }
}

function uniqueReferenceFingerprint(references: readonly CredentialReferenceRow[]): string | null {
  const fingerprints = new Set(
    references.map((reference) => reference.provider_account_fingerprint)
  );
  if (fingerprints.size !== 1) return null;
  return fingerprints.values().next().value ?? null;
}

async function continuityFingerprint(appId: string): Promise<string> {
  return getPrivyProviderAccountFingerprint(appId);
}

function rotationResult(
  credential: LifecycleCredentialRow,
  status: "success"
): ProviderCredentialRotationResult;
function rotationResult(
  credential: LifecycleCredentialRow,
  status: "failed",
  code: RotationFailureCode
): ProviderCredentialRotationResult;
function rotationResult(
  credential: LifecycleCredentialRow,
  status: "retry_unknown",
  code: "provider_response_unknown"
): ProviderCredentialRotationResult;
function rotationResult(
  credential: LifecycleCredentialRow,
  status: "success" | "failed" | "retry_unknown",
  code?: RotationFailureCode | "provider_response_unknown"
): ProviderCredentialRotationResult {
  const providerCredential = mapProviderCredential(credential);
  if (status === "success") return { providerCredential, rotation: { status } };
  if (status === "retry_unknown") {
    return { providerCredential, rotation: { status, code: "provider_response_unknown" } };
  }
  return { providerCredential, rotation: { status, code: code as RotationFailureCode } };
}

function safeRotationFailureCode(value: string | null): RotationFailureCode | null {
  return value === "invalid_credentials" || value === "provider_account_mismatch" ? value : null;
}

async function rotationFingerprint(
  context: LifecycleContext,
  credentialId: string,
  fields: { appId: string; appSecret: string }
): Promise<string> {
  const pepper = context.c.env.CREDENTIAL_FINGERPRINT_PEPPER;
  if (!pepper) throw internalError();
  return hashString(
    JSON.stringify(
      normalizeForFingerprint({
        version: 1,
        operation: "provider_credential_rotation",
        target: { organizationId: context.organizationId, credentialId },
        fields,
      })
    ),
    pepper
  );
}

function createStoredSecretStore(
  c: Context<{ Bindings: Env }>,
  credentialId: string
): CredentialSecretStore {
  try {
    const store = createCredentialSecretStore(c.env);
    if (store.storageBackend === "runtime_env") throw internalError();
    return store;
  } catch (error) {
    logLifecycleFailure(c, "secret_store_create", credentialId, error);
    if (error instanceof AppError) throw error;
    throw internalError();
  }
}

function createPersistedSecretStore(
  c: Context<{ Bindings: Env }>,
  backend: LifecycleCredentialRow["storage_backend"],
  credentialId: string
): CredentialSecretStore {
  if (backend === "runtime_env") throw conflict(ROTATION_UNAVAILABLE);
  try {
    return createCredentialSecretStore(c.env, backend);
  } catch (error) {
    logLifecycleFailure(c, "secret_store_create", credentialId, error);
    throw internalError();
  }
}

async function writeRotationSecret(
  context: LifecycleContext,
  store: CredentialSecretStore,
  candidateId: string,
  appId: string,
  appSecret: string
): Promise<StoredCredentialSecret> {
  try {
    return await store.write({
      orgId: context.organizationId,
      provider: "privy",
      providerCredentialId: candidateId,
      payload: { appId, appSecret },
    });
  } catch (error) {
    logLifecycleFailure(context.c, "secret_write", candidateId, error);
    if (error instanceof CredentialSecretStoreError && error.code === "UPSTREAM_ERROR") {
      if (store.storageBackend === "gcp_secret_manager") {
        logSecretWriteOutcomeUnknown(context.c, candidateId, store.storageBackend);
      }
      throw providerUnavailable("Credential storage is temporarily unavailable");
    }
    throw internalError();
  }
}

async function readPrivyCredential(
  store: CredentialSecretStore,
  context: LifecycleContext,
  row: LifecycleCredentialWithSecretRow
): Promise<PrivyCredentialAuthentication> {
  let payload: CredentialSecretPayload;
  try {
    payload = await store.read({ orgId: context.organizationId, stored: storedSecret(row) });
  } catch (error) {
    logLifecycleFailure(context.c, "secret_read", row.id, error);
    if (error instanceof CredentialSecretStoreError && error.code === "UPSTREAM_ERROR") {
      throw providerUnavailable("Credential storage is temporarily unavailable");
    }
    throw internalError();
  }
  const appId = typeof payload.appId === "string" ? payload.appId.trim() : "";
  const appSecret = typeof payload.appSecret === "string" ? payload.appSecret : "";
  if (!appId || !appSecret) throw internalError();
  return { appId, appSecret };
}

function storedSecret(row: LifecycleCredentialWithSecretRow): StoredCredentialSecret {
  return {
    storageBackend: row.storage_backend,
    secretRef: row.secret_ref ?? undefined,
    secretVersionRef: row.secret_version_ref ?? undefined,
    encryptedSecretPayload: row.encrypted_secret_payload ?? undefined,
  };
}

async function compensateSecretWrite(
  c: Context<{ Bindings: Env }>,
  store: CredentialSecretStore,
  stored: StoredCredentialSecret,
  candidateId: string
): Promise<void> {
  if (stored.storageBackend !== "gcp_secret_manager" || !stored.secretVersionRef) return;
  try {
    await store.destroyVersion({ secretVersionRef: stored.secretVersionRef });
  } catch {
    logCleanupFailure(c, candidateId, stored.storageBackend);
  }
}

async function cleanupRejectedCandidate(
  c: Context<{ Bindings: Env }>,
  candidate: LifecycleCredentialWithSecretRow
): Promise<void> {
  if (candidate.storage_backend !== "gcp_secret_manager" || !candidate.secret_version_ref) return;
  try {
    const store = createPersistedSecretStore(c, candidate.storage_backend, candidate.id);
    await store.destroyVersion({ secretVersionRef: candidate.secret_version_ref });
  } catch {
    logCleanupFailure(c, candidate.id, candidate.storage_backend);
  }
}

function mapLifecycleCredential(row: LifecycleCredentialRow): LifecycleProviderCredential {
  return { ...mapProviderCredential(row), source: row.source };
}

function logUnresolvedAuditIntent(
  context: LifecycleContext,
  intent: AuditIntent,
  credentialId: string
): void {
  // A visible transition after a failed COMMIT may belong to another request.
  // Keep this intent unresolved until its own transaction outcome is proven.
  logEvent("warn", {
    event: "sdp_api_credential_lifecycle_audit_unresolved",
    organization_id: context.organizationId,
    project_id: context.projectId,
    provider: "privy",
    provider_credential_id: credentialId,
    audit_intent_id: intent.id,
    request_id: context.c.get("requestId"),
    operation: intent.entry.action,
    reason: "commit_outcome_unknown",
  });
}

function logLifecycleFailure(
  c: Context<{ Bindings: Env }>,
  stage: string,
  credentialId: string,
  cause: unknown
): void {
  if (cause instanceof AppError) return;
  const auth = getAuth(c);
  logEvent("error", {
    event: "sdp_api_credential_lifecycle_failure",
    stage,
    organization_id: auth.organizationId,
    project_id: auth.projectId,
    provider: "privy",
    provider_credential_id: credentialId,
    request_id: c.get("requestId"),
    ...describeError(cause),
  });
}

function logCleanupFailure(
  c: Context<{ Bindings: Env }>,
  credentialId: string,
  storageBackend: "gcp_secret_manager"
): void {
  getLogger().error(
    {
      providerCredentialId: credentialId,
      provider: "privy",
      storageBackend,
      requestId: c.get("requestId"),
      reason: "secret_cleanup_failed",
    },
    "provider_credential_orphan_risk"
  );
}

function logSecretWriteOutcomeUnknown(
  c: Context<{ Bindings: Env }>,
  credentialId: string,
  storageBackend: StoredCredentialSecret["storageBackend"]
): void {
  if (storageBackend !== "gcp_secret_manager") return;
  getLogger().error(
    {
      providerCredentialId: credentialId,
      provider: "privy",
      storageBackend,
      requestId: c.get("requestId"),
      reason: "secret_write_outcome_unknown",
    },
    "provider_credential_orphan_risk"
  );
}

async function closeRejectedIntent(
  context: LifecycleContext,
  intent: AuditIntent,
  event: string
): Promise<void> {
  await context.audit.completeCritical(context.c, intent, {
    action: "maintenance",
    resourceType: "audit_ledger",
    resourceId: intent.id,
    status: "failure",
    metadata: { event },
  });
}
