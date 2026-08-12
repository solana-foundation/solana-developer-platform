/**
 * Audit Logging Service
 *
 * Records all significant actions for compliance and debugging.
 */

import { redactCredentialSecrets } from "@sdp/custody";
import type { Context } from "hono";
import { parseOptionalPostgresJson } from "@/db/postgres-utils";
import { getClientIp } from "@/lib/client-ip";
import type { KVStore } from "@/runtime/kv";
import { createKVStoreSet } from "@/runtime/kv-redis";
import { getLogger } from "@/runtime/logger";
import type { Env } from "@/types/env";

// Runtime list is the source of truth for the AuditAction type so callers can
// validate arbitrary input (e.g. an ?action= query filter) at runtime.
export const AUDIT_ACTIONS = [
  "create",
  "read",
  "update",
  "delete",
  "revoke",
  "invite",
  "accept_invite",
  "login",
  "logout",
  "api_call",
  "deploy",
  "mint",
  "burn",
  "freeze",
  "unfreeze",
  "seize",
  "force_burn",
  "update_authority",
  "pause",
  "unpause",
  // Transaction actions
  "submit",
  "submit_failed",
  "sign",
  "sign_requested",
  // BYO credential lifecycle actions
  "validate_failed",
  "check",
  "activate",
  "rotate",
  "rollback",
  "deactivate",
  "blocked_deactivation",
  // Workflow automation (system actor)
  "workflow_action_executed",
  "workflow_action_failed",
  // Workflow human decisions (real actor — records WHO approved/declined a held action)
  "workflow_execution_approved",
  "workflow_execution_rejected",
  "workflow_execution_retried",
  // Privileged audit-ledger operations (verification checkpoints, restore evidence).
  "maintenance",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export function isAuditAction(value: string): value is AuditAction {
  return (AUDIT_ACTIONS as readonly string[]).includes(value);
}

export type ResourceType =
  | "organization"
  | "user"
  | "api_key"
  | "invitation"
  | "allowlist"
  | "member"
  | "project"
  | "project_member"
  | "session"
  | "token"
  | "token_transaction"
  | "token_allowlist"
  | "frozen_account"
  | "custody_config"
  | "custody_wallet"
  // Transaction resources
  | "transaction"
  | "signing_request"
  | "counterparty"
  | "counterparty_account"
  | "asset_profile"
  | "provider_credential"
  | "custody_connection"
  | "workflow"
  | "workflow_execution"
  | "audit_ledger";

export interface AuditLogEntry {
  organizationId?: string;
  userId?: string;
  apiKeyId?: string;
  action: AuditAction;
  resourceType: ResourceType;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  status?: "success" | "failure";
}

export interface SystemAuditLogEntry extends AuditLogEntry {
  /** Correlation id supplied by a scheduled job or other non-request caller. */
  requestId?: string;
}

/**
 * Durable admission evidence written before an irreversible operation starts.
 * The public audit feed continues to expose only the eventual outcome event;
 * intents are maintenance records for operators and integrity monitoring.
 */
export interface AuditIntent {
  id: string;
  entry: AuditLogEntry;
}

export interface AuditLedgerIntegrity {
  valid: boolean;
  checkedEntries: number;
  firstInvalidSequence: number | null;
  headHash: string | null;
  unresolvedCriticalIntents: number;
  externalCheckpointMatches: boolean;
}

export interface CriticalAuditOutcome {
  status: "success" | "failure";
  metadata: Record<string, unknown>;
}

export const AUDIT_LEDGER_CHECKPOINT_KEY = "audit-ledger:checkpoint:v1";
export const AUDIT_LEDGER_SESSION_LOCK_KEY = "sdp:audit-ledger:external-checkpoint";

interface AuditLedgerCheckpoint {
  sequence: number;
  headHash: string;
}

interface PendingAuditLedgerCheckpoint {
  previous: AuditLedgerCheckpoint | null;
  next: AuditLedgerCheckpoint;
}

interface AuditLedgerHead {
  ledger_sequence: number;
  previous_entry_hash: string | null;
  entry_hash: string;
  entry_hash_valid: boolean;
  anchor_matches: boolean;
}

function serializeCheckpoint(checkpoint: AuditLedgerCheckpoint): string {
  return JSON.stringify(checkpoint);
}

function parseCheckpoint(value: string | null): AuditLedgerCheckpoint {
  if (value === null) return { sequence: 0, headHash: "" };
  try {
    const parsed = JSON.parse(value) as Partial<AuditLedgerCheckpoint>;
    if (
      !("pending" in parsed) &&
      Number.isSafeInteger(parsed.sequence) &&
      Number(parsed.sequence) > 0 &&
      typeof parsed.headHash === "string" &&
      /^[0-9a-f]{64}$/.test(parsed.headHash)
    ) {
      return { sequence: Number(parsed.sequence), headHash: parsed.headHash };
    }
  } catch {
    // Invalid external state is represented by an impossible sequence below.
  }
  return { sequence: -1, headHash: "" };
}

function isValidCheckpoint(value: unknown): value is AuditLedgerCheckpoint {
  if (!value || typeof value !== "object") return false;
  const checkpoint = value as Partial<AuditLedgerCheckpoint>;
  return (
    Number.isSafeInteger(checkpoint.sequence) &&
    Number(checkpoint.sequence) > 0 &&
    typeof checkpoint.headHash === "string" &&
    /^[0-9a-f]{64}$/.test(checkpoint.headHash)
  );
}

function parsePendingCheckpoint(value: string | null): PendingAuditLedgerCheckpoint | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as {
      pending?: unknown;
      previous?: unknown;
      next?: unknown;
    };
    if (
      parsed.pending === true &&
      (parsed.previous === null || isValidCheckpoint(parsed.previous)) &&
      isValidCheckpoint(parsed.next) &&
      parsed.next.sequence === (parsed.previous?.sequence ?? 0) + 1
    ) {
      return { previous: parsed.previous, next: parsed.next };
    }
  } catch {
    // Malformed pending state remains fail-closed.
  }
  return null;
}

function serializePendingCheckpoint(
  previousCheckpoint: string | null,
  nextCheckpoint: string
): string {
  return JSON.stringify({
    pending: true,
    previous: previousCheckpoint ? JSON.parse(previousCheckpoint) : null,
    next: JSON.parse(nextCheckpoint),
  });
}

function checkpointForHead(head: AuditLedgerHead | null): string | null {
  return head
    ? serializeCheckpoint({ sequence: head.ledger_sequence, headHash: head.entry_hash })
    : null;
}

function assertValidCurrentHead(head: AuditLedgerHead | null): void {
  if (!head) return;
  const previousHashValid =
    head.ledger_sequence === 1
      ? head.previous_entry_hash === null
      : typeof head.previous_entry_hash === "string" &&
        /^[0-9a-f]{64}$/.test(head.previous_entry_hash);
  if (
    !Number.isSafeInteger(head.ledger_sequence) ||
    head.ledger_sequence < 1 ||
    !/^[0-9a-f]{64}$/.test(head.entry_hash) ||
    !previousHashValid ||
    !head.entry_hash_valid ||
    !head.anchor_matches
  ) {
    throw new Error("Current audit-ledger head failed seal or anchor validation");
  }
}

async function reconcileExternalCheckpoint(
  head: AuditLedgerHead | null,
  checkpointStore: KVStore
): Promise<string | null> {
  assertValidCurrentHead(head);
  const expectedCheckpoint = checkpointForHead(head);
  const externalCheckpoint = await checkpointStore.get(AUDIT_LEDGER_CHECKPOINT_KEY);
  if (externalCheckpoint === expectedCheckpoint) return expectedCheckpoint;

  // A pending witness whose `next` value is the current, valid PostgreSQL
  // head proves that PostgreSQL committed and only the post-commit promotion
  // was interrupted. Finalizing that exact CAS is safe. We deliberately do
  // not roll a stale pending witness back when PostgreSQL matches `previous`:
  // that state is indistinguishable from privileged committed-tail deletion
  // and remains locked for operator investigation. The originating writer
  // may restore its exact witness only while PostgreSQL positively confirms
  // that same transaction rolled back and the session lock is still held.
  const pending = parsePendingCheckpoint(externalCheckpoint);
  const predecessorMatches =
    pending !== null &&
    head !== null &&
    (pending.previous === null
      ? head.ledger_sequence === 1 && head.previous_entry_hash === null
      : pending.previous.sequence === head.ledger_sequence - 1 &&
        pending.previous.headHash === head.previous_entry_hash);
  if (pending && predecessorMatches && serializeCheckpoint(pending.next) === expectedCheckpoint) {
    const finalized = await checkpointStore.compareAndSet(
      AUDIT_LEDGER_CHECKPOINT_KEY,
      externalCheckpoint,
      expectedCheckpoint
    );
    if (finalized) return expectedCheckpoint;
    if ((await checkpointStore.get(AUDIT_LEDGER_CHECKPOINT_KEY)) === expectedCheckpoint) {
      return expectedCheckpoint;
    }
  }

  if (externalCheckpoint === null && expectedCheckpoint !== null) {
    const seeded = await checkpointStore.compareAndSet(
      AUDIT_LEDGER_CHECKPOINT_KEY,
      null,
      expectedCheckpoint
    );
    if (seeded) {
      getLogger().warn(
        { event: "audit_checkpoint_bootstrapped", sequence: head?.ledger_sequence },
        "External audit-ledger checkpoint was absent; bootstrapped from the verified database head"
      );
      return expectedCheckpoint;
    }
    if ((await checkpointStore.get(AUDIT_LEDGER_CHECKPOINT_KEY)) === expectedCheckpoint) {
      return expectedCheckpoint;
    }
  }

  throw new Error("External audit-ledger checkpoint diverged; writes are locked");
}

/**
 * A security-sensitive action must never look successful when its audit record
 * was not persisted. Callers receive this error instead of silently continuing.
 */
export class AuditPersistenceError extends Error {
  constructor(options: { cause?: unknown } = {}) {
    super("Required audit record could not be persisted", options);
    this.name = "AuditPersistenceError";
  }
}

/**
 * An identity value fit to show a human, or null.
 *
 * A misconfigured Clerk token customization passes unknown shortcodes through unsubstituted, so
 * a user row can hold a literal `{{...}}` placeholder where its email or name belongs.
 * Printed verbatim it reads as a rendering bug rather than the data problem it is, so it
 * is treated as absent and the generic actor label stands in instead.
 *
 * Deliberately not an email-shape check: `name` is free-form, and the fault being guarded
 * against is the unsubstituted placeholder, whichever field it landed in.
 */
export function displayableIdentity(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || /\{\{.*\}\}/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

/**
 * How a user actor is named in an audit feed.
 *
 * Two failures are deliberately not collapsed into one label. A user with nothing
 * recorded is ordinary; a user whose recorded identity is unusable means the stored data
 * is broken. Labelling both "Team member" makes corruption read as normal and removes the
 * only signal an operator would have — which is how this went unnoticed until a
 * placeholder happened to be visible on screen.
 */
function resolveUserActorLabel(name: string | null, email: string | null): string {
  const displayable = displayableIdentity(name) ?? displayableIdentity(email);
  if (displayable) {
    return displayable;
  }

  const somethingWasRecorded = Boolean(name?.trim()) || Boolean(email?.trim());
  return somethingWasRecorded ? "Unknown user" : "Team member";
}

export class AuditService {
  constructor(
    private db: DatabaseClient,
    private checkpointStore?: KVStore
  ) {}

  async log(c: Context<{ Bindings: Env }>, entry: AuditLogEntry): Promise<void> {
    // Resolve the actor from whichever auth context is present. Dashboard
    // requests carry a Clerk/session context (a user), API requests carry an
    // apiKey context; earlier this only read `apiKey`, so dashboard-driven
    // events were written with a null organization_id/user_id and became
    // invisible to org-scoped queries.
    const auth = c.get("apiKey");
    const clerk = c.get("clerk");
    const session = c.get("session");
    const requestId = c.get("requestId");

    const organizationId =
      entry.organizationId ||
      auth?.organizationId ||
      clerk?.organizationId ||
      session?.organizationId ||
      null;
    const userId = entry.userId || clerk?.userId || session?.userId || null;
    const apiKeyId = entry.apiKeyId || auth?.id || null;

    const ipAddress = getClientIp(c);
    const userAgent = c.req.header("user-agent") || null;

    await this.persist(
      entry,
      {
        organizationId,
        userId,
        apiKeyId,
        ipAddress,
        userAgent,
        requestId,
      },
      this.checkpointStore ?? createKVStoreSet(c.env).cache
    );
  }

  /**
   * Persist an event from a scheduled job or other caller without an HTTP
   * context. It intentionally shares the exact same fail-closed write path as
   * request audit events.
   */
  async logSystem(entry: SystemAuditLogEntry): Promise<void> {
    if (!this.checkpointStore) {
      throw new AuditPersistenceError({
        cause: new Error("System audit writers require the external checkpoint store"),
      });
    }
    await this.persist(
      entry,
      {
        organizationId: entry.organizationId ?? null,
        userId: entry.userId ?? null,
        apiKeyId: entry.apiKeyId ?? null,
        ipAddress: null,
        userAgent: null,
        requestId: entry.requestId ?? null,
      },
      this.checkpointStore
    );
  }

  /**
   * Admit an irreversible operation only after its intent is durable.
   *
   * If this write fails, the caller must not invoke the provider/KMS/on-chain
   * side effect. If the later outcome write fails, the immutable unresolved
   * intent remains visible to verification and reconciliation instead of
   * turning an already-completed operation into a misleading 500 response.
   */
  async beginCritical(c: Context<{ Bindings: Env }>, entry: AuditLogEntry): Promise<AuditIntent> {
    const intentId = `aint_${crypto.randomUUID()}`;
    await this.log(c, {
      action: "maintenance",
      resourceType: "audit_ledger",
      resourceId: intentId,
      metadata: {
        auditPhase: "intent",
        target: {
          action: entry.action,
          resourceType: entry.resourceType,
          resourceId: entry.resourceId ?? null,
          metadata: entry.metadata ? redactCredentialSecrets(entry.metadata) : null,
        },
      },
      status: "success",
    });
    return { id: intentId, entry };
  }

  /**
   * Append the outcome for a previously admitted critical operation.
   *
   * A failed outcome insert is deliberately not rethrown: the provider action
   * may already be irreversible. The durable intent prevents silent omission,
   * while this structured error and the unresolved-intent verification gate
   * page operators for reconciliation.
   */
  async completeCritical(
    c: Context<{ Bindings: Env }>,
    intent: AuditIntent,
    outcome: Partial<
      Pick<AuditLogEntry, "action" | "resourceType" | "resourceId" | "metadata" | "status">
    > = {}
  ): Promise<boolean> {
    try {
      await this.log(c, {
        ...intent.entry,
        ...outcome,
        metadata: {
          ...intent.entry.metadata,
          ...outcome.metadata,
          auditPhase: "outcome",
          auditIntentId: intent.id,
        },
        status: outcome.status ?? "success",
      });
      return true;
    } catch (error) {
      getLogger().error(
        {
          event: "audit_critical_outcome_persistence_failed",
          auditIntentId: intent.id,
          targetAction: intent.entry.action,
          targetResourceType: intent.entry.resourceType,
          targetResourceId: intent.entry.resourceId ?? null,
          error: redactCredentialSecrets(error),
        },
        "Critical operation outcome was not persisted; durable audit intent requires reconciliation"
      );
      return false;
    }
  }

  /**
   * Read the durable outcome for a resource whose ordinary state write may
   * have failed after an irreversible effect. Callers use this immutable
   * evidence to repair idempotent replays without repeating the effect.
   */
  async findCriticalOutcome(options: {
    organizationId: string;
    action: AuditAction;
    resourceType: ResourceType;
    resourceId: string;
  }): Promise<CriticalAuditOutcome | null> {
    const row = await this.db
      .prepare(
        `SELECT status, metadata
         FROM audit_logs
         WHERE organization_id = ?
           AND action = ?
           AND resource_type = ?
           AND resource_id = ?
           AND CASE
             WHEN metadata IS NOT NULL AND pg_input_is_valid(metadata, 'jsonb')
             THEN metadata::jsonb ->> 'auditPhase' = 'outcome'
             ELSE false
           END
         ORDER BY ledger_sequence DESC
         LIMIT 1`
      )
      .bind(options.organizationId, options.action, options.resourceType, options.resourceId)
      .first<{ status: "success" | "failure"; metadata: string }>();
    if (!row) return null;
    const metadata = parseOptionalPostgresJson<Record<string, unknown>>(row.metadata);
    return metadata ? { status: row.status, metadata } : null;
  }

  /** Verify every immutable link and return the current externally anchorable head. */
  async verifyIntegrity(): Promise<AuditLedgerIntegrity> {
    if (!this.checkpointStore) {
      throw new AuditPersistenceError({
        cause: new Error("Integrity verification requires the external checkpoint store"),
      });
    }
    const externalCheckpoint = await this.checkpointStore.get(AUDIT_LEDGER_CHECKPOINT_KEY);
    const parsedCheckpoint = parseCheckpoint(externalCheckpoint);
    const result = await this.db
      .prepare(
        `SELECT valid, checked_entries, first_invalid_sequence,
                encode(head_hash, 'hex') AS head_hash,
                unresolved_critical_intents
         FROM sdp_verify_audit_ledger(?, NULLIF(?, ''))`
      )
      .bind(parsedCheckpoint.sequence, parsedCheckpoint.headHash)
      .first<{
        valid: boolean;
        checked_entries: number;
        first_invalid_sequence: number | null;
        head_hash: string | null;
        unresolved_critical_intents: number;
      }>();

    if (!result) {
      throw new AuditPersistenceError();
    }

    const expectedCheckpoint =
      result.checked_entries === 0 || result.head_hash === null
        ? null
        : serializeCheckpoint({
            sequence: result.checked_entries,
            headHash: result.head_hash,
          });
    const externalCheckpointMatches = externalCheckpoint === expectedCheckpoint;

    return {
      valid: result.valid && externalCheckpointMatches,
      checkedEntries: result.checked_entries,
      firstInvalidSequence: result.first_invalid_sequence,
      headHash: result.head_hash,
      unresolvedCriticalIntents: result.unresolved_critical_intents,
      externalCheckpointMatches,
    };
  }

  private async persist(
    entry: AuditLogEntry,
    actor: {
      organizationId: string | null;
      userId: string | null;
      apiKeyId: string | null;
      ipAddress: string | null;
      userAgent: string | null;
      requestId: string | null;
    },
    checkpointStore: KVStore
  ): Promise<void> {
    const id = `aud_${crypto.randomUUID()}`;
    const metadata = entry.metadata ? redactCredentialSecrets(entry.metadata) : null;

    try {
      const lockedTransactionWithPostCommit = this.db.lockedTransactionWithPostCommit?.bind(
        this.db
      );
      if (!lockedTransactionWithPostCommit) {
        throw new Error("Database client cannot serialize post-commit audit checkpoints");
      }

      await lockedTransactionWithPostCommit(
        AUDIT_LEDGER_SESSION_LOCK_KEY,
        async (tx) => {
          const currentHead = await tx.queryOne<AuditLedgerHead>(
            `SELECT ledger.ledger_sequence,
                    encode(ledger.previous_entry_hash, 'hex') AS previous_entry_hash,
                    encode(ledger.entry_hash, 'hex') AS entry_hash,
                    ledger.entry_hash = sdp_audit_log_hash(
                      ledger.ledger_sequence,
                      ledger.id,
                      ledger.organization_id,
                      ledger.user_id,
                      ledger.api_key_id,
                      ledger.action,
                      ledger.resource_type,
                      ledger.resource_id,
                      ledger.metadata,
                      ledger.ip_address,
                      ledger.user_agent,
                      ledger.request_id,
                      ledger.status,
                      ledger.created_at,
                      ledger.previous_entry_hash
                    ) AS entry_hash_valid,
                    anchor.entry_hash = ledger.entry_hash AS anchor_matches
             FROM audit_logs AS ledger
             LEFT JOIN audit_ledger_anchors AS anchor
               ON anchor.ledger_sequence = ledger.ledger_sequence
             ORDER BY ledger.ledger_sequence DESC
             LIMIT 1`
          );
          const expectedCheckpoint = await reconcileExternalCheckpoint(
            currentHead,
            checkpointStore
          );

          const inserted = await tx.queryOne<{
            ledger_sequence: number;
            previous_entry_hash: string | null;
            entry_hash: string;
          }>(
            `INSERT INTO audit_logs (
               id, organization_id, user_id, api_key_id, action, resource_type,
               resource_id, metadata, ip_address, user_agent, request_id, status
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             RETURNING ledger_sequence,
                       encode(previous_entry_hash, 'hex') AS previous_entry_hash,
                       encode(entry_hash, 'hex') AS entry_hash`,
            [
              id,
              actor.organizationId,
              actor.userId,
              actor.apiKeyId,
              entry.action,
              entry.resourceType,
              entry.resourceId || null,
              metadata ? JSON.stringify(metadata) : null,
              actor.ipAddress,
              actor.userAgent,
              actor.requestId,
              entry.status || "success",
            ]
          );

          if (!inserted) {
            throw new Error("Audit insert returned no sealed row");
          }

          const insertedPreviousCheckpoint =
            inserted.ledger_sequence === 1
              ? null
              : serializeCheckpoint({
                  sequence: inserted.ledger_sequence - 1,
                  headHash: inserted.previous_entry_hash ?? "",
                });
          if (insertedPreviousCheckpoint !== expectedCheckpoint) {
            throw new Error("Audit-ledger head changed outside the serialized writer");
          }

          const nextCheckpoint = serializeCheckpoint({
            sequence: inserted.ledger_sequence,
            headHash: inserted.entry_hash,
          });
          const pendingCheckpoint = serializePendingCheckpoint(expectedCheckpoint, nextCheckpoint);
          // Publish the next sealed head before PostgreSQL commits. A verifier
          // that races the commit sees an explicit pending witness and fails
          // closed; deleting the committed tail can no longer restore agreement
          // with the predecessor checkpoint. A confirmed rollback restores this
          // exact witness while the session lock remains held; an ambiguous crash
          // or lost commit outcome remains locked for operator investigation.
          const witnessed = await checkpointStore.compareAndSet(
            AUDIT_LEDGER_CHECKPOINT_KEY,
            expectedCheckpoint,
            pendingCheckpoint
          );
          if (!witnessed) {
            throw new Error("External audit-ledger pending witness was not established");
          }

          return { expectedCheckpoint, pendingCheckpoint, nextCheckpoint };
        },
        async ({ pendingCheckpoint, nextCheckpoint }) => {
          const advanced = await checkpointStore.compareAndSet(
            AUDIT_LEDGER_CHECKPOINT_KEY,
            pendingCheckpoint,
            nextCheckpoint
          );
          if (!advanced) {
            throw new Error(
              "External audit-ledger checkpoint did not advance after commit; writes are locked"
            );
          }
        },
        async ({ expectedCheckpoint, pendingCheckpoint }) => {
          const restored =
            expectedCheckpoint === null
              ? await checkpointStore.compareAndDelete(
                  AUDIT_LEDGER_CHECKPOINT_KEY,
                  pendingCheckpoint
                )
              : await checkpointStore.compareAndSet(
                  AUDIT_LEDGER_CHECKPOINT_KEY,
                  pendingCheckpoint,
                  expectedCheckpoint
                );
          if (
            !restored &&
            (await checkpointStore.get(AUDIT_LEDGER_CHECKPOINT_KEY)) !== expectedCheckpoint
          ) {
            throw new Error(
              "External audit-ledger pending witness was not restored after rollback; writes are locked"
            );
          }
        }
      );
    } catch (err) {
      getLogger().error({ error: redactCredentialSecrets(err) }, "Failed to write audit log");
      throw err instanceof AuditPersistenceError ? err : new AuditPersistenceError({ cause: err });
    }
  }

  async getForOrganization(
    organizationId: string,
    options: {
      limit?: number;
      offset?: number;
      action?: AuditAction;
      resourceType?: ResourceType;
      startDate?: string;
      endDate?: string;
    } = {}
  ) {
    const { limit = 50, offset = 0, action, resourceType, startDate, endDate } = options;

    let query = `
      SELECT id, organization_id, user_id, api_key_id, action, resource_type,
             resource_id, metadata, ip_address, request_id, status, created_at
      FROM audit_logs
      WHERE organization_id = ?
    `;
    const params: (string | number)[] = [organizationId];

    if (action) {
      query += " AND action = ?";
      params.push(action);
    }

    if (resourceType) {
      query += " AND resource_type = ?";
      params.push(resourceType);
    }

    if (startDate) {
      query += " AND created_at >= ?";
      params.push(startDate);
    }

    if (endDate) {
      query += " AND created_at <= ?";
      params.push(endDate);
    }

    query += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const results = await this.db
      .prepare(query)
      .bind(...params)
      .all();

    return results.results.map((row) => ({
      id: row.id as string,
      organizationId: row.organization_id as string,
      userId: row.user_id as string | null,
      apiKeyId: row.api_key_id as string | null,
      action: row.action as AuditAction,
      resourceType: row.resource_type as ResourceType,
      resourceId: row.resource_id as string | null,
      metadata: parseOptionalPostgresJson<Record<string, unknown>>(row.metadata),
      ipAddress: row.ip_address as string | null,
      requestId: row.request_id as string | null,
      status: row.status as "success" | "failure",
      createdAt: row.created_at as string,
    }));
  }

  /**
   * Get count of audit logs for pagination
   */
  async countForOrganization(
    organizationId: string,
    options: {
      action?: AuditAction;
      resourceType?: ResourceType;
    } = {}
  ): Promise<number> {
    const { action, resourceType } = options;

    let query = "SELECT COUNT(*) as count FROM audit_logs WHERE organization_id = ?";
    const params: string[] = [organizationId];

    if (action) {
      query += " AND action = ?";
      params.push(action);
    }

    if (resourceType) {
      query += " AND resource_type = ?";
      params.push(resourceType);
    }

    const result = await this.db
      .prepare(query)
      .bind(...params)
      .first<{ count: number }>();

    return result?.count || 0;
  }

  /**
   * Query audit events for a single asset (issued token). Aggregates every event
   * tied to the token: rows logged directly against the token id, plus child
   * events (transactions, allowlist entries, frozen accounts) which store the
   * owning token id in `metadata.tokenId`. Resolves the actor to a display label.
   */
  async getForAsset(
    organizationId: string,
    tokenId: string,
    options: AssetAuditFilters & { limit?: number; offset?: number } = {}
  ): Promise<AssetAuditRecord[]> {
    const { limit = 50, offset = 0, ...filters } = options;

    // metadata is stored as JSON text. Reading `tokenId` needs a jsonb cast, but a
    // single non-null malformed row would abort the whole org scan (the OR is
    // evaluated per row), so the cast is guarded by pg_input_is_valid (PG16+)
    // inside a CASE — Postgres does not short-circuit AND in a WHERE clause, so a
    // plain `... AND pg_input_is_valid(...) AND (cast)` could still hit the cast.
    let query = `
      SELECT a.id, a.user_id, a.api_key_id, a.action, a.resource_type, a.resource_id,
             a.metadata, a.status, a.created_at,
             ak.name AS api_key_name, u.name AS user_name, u.email AS user_email
      FROM audit_logs a
      LEFT JOIN api_keys ak ON ak.id = a.api_key_id
      LEFT JOIN users u ON u.id = a.user_id
      WHERE a.organization_id = ?
        AND (
          a.resource_id = ?
          OR (
            CASE
              WHEN a.metadata IS NOT NULL AND pg_input_is_valid(a.metadata, 'jsonb')
              THEN (a.metadata::jsonb) ->> 'tokenId' = ?
              ELSE false
            END
          )
        )
    `;
    const params: (string | number)[] = [organizationId, tokenId, tokenId];

    const filter = buildAssetFilterClause(filters);
    query += filter.clause;
    params.push(...filter.params);

    query += " ORDER BY a.created_at DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    const results = await this.db
      .prepare(query)
      .bind(...params)
      .all();

    return results.results.map((row) => {
      const userId = (row.user_id as string | null) ?? null;
      const apiKeyId = (row.api_key_id as string | null) ?? null;
      const actorType: "user" | "api_key" | "system" = userId
        ? "user"
        : apiKeyId
          ? "api_key"
          : "system";
      const actorLabel = userId
        ? resolveUserActorLabel(row.user_name as string | null, row.user_email as string | null)
        : apiKeyId
          ? (row.api_key_name as string | null) || "API key"
          : "SDP";

      return {
        id: row.id as string,
        action: row.action as AuditAction,
        resourceType: row.resource_type as ResourceType,
        resourceId: (row.resource_id as string | null) ?? null,
        userId,
        apiKeyId,
        actorType,
        actorLabel,
        metadata: parseOptionalPostgresJson<Record<string, unknown>>(row.metadata),
        status: row.status as "success" | "failure",
        createdAt: row.created_at as string,
      };
    });
  }

  /**
   * Count of audit events for a single asset (for pagination totals).
   */
  async countForAsset(
    organizationId: string,
    tokenId: string,
    options: AssetAuditFilters = {}
  ): Promise<number> {
    let query = `
      SELECT COUNT(*) as count
      FROM audit_logs a
      WHERE a.organization_id = ?
        AND (
          a.resource_id = ?
          OR (
            CASE
              WHEN a.metadata IS NOT NULL AND pg_input_is_valid(a.metadata, 'jsonb')
              THEN (a.metadata::jsonb) ->> 'tokenId' = ?
              ELSE false
            END
          )
        )
    `;
    const params: (string | number)[] = [organizationId, tokenId, tokenId];

    const filter = buildAssetFilterClause(options);
    query += filter.clause;
    params.push(...filter.params);

    const result = await this.db
      .prepare(query)
      .bind(...params)
      .first<{ count: number }>();

    return result?.count || 0;
  }
}

/**
 * Filters for the per-asset activity feed. `actorType` has no stored column —
 * it's derived from which actor id is set, so it maps to id-presence predicates.
 */
export interface AssetAuditFilters {
  action?: AuditAction;
  status?: "success" | "failure";
  actorType?: "user" | "api_key" | "system";
}

/** Build the shared `AND ...` filter clause used by getForAsset/countForAsset. */
function buildAssetFilterClause(filters: AssetAuditFilters): {
  clause: string;
  params: (string | number)[];
} {
  let clause = "";
  const params: (string | number)[] = [];

  if (filters.action) {
    clause += " AND a.action = ?";
    params.push(filters.action);
  }
  if (filters.status) {
    clause += " AND a.status = ?";
    params.push(filters.status);
  }
  // actorType mirrors the actorType derivation in getForAsset: user wins if a
  // user id is set, else api_key, else system (no human/key actor).
  switch (filters.actorType) {
    case "user":
      clause += " AND a.user_id IS NOT NULL";
      break;
    case "api_key":
      clause += " AND a.user_id IS NULL AND a.api_key_id IS NOT NULL";
      break;
    case "system":
      clause += " AND a.user_id IS NULL AND a.api_key_id IS NULL";
      break;
  }

  return { clause, params };
}

/** An audit event scoped to one asset, with the actor resolved to a label. */
export interface AssetAuditRecord {
  id: string;
  action: AuditAction;
  resourceType: ResourceType;
  resourceId: string | null;
  userId: string | null;
  apiKeyId: string | null;
  actorType: "user" | "api_key" | "system";
  actorLabel: string;
  metadata: Record<string, unknown> | null;
  status: "success" | "failure";
  createdAt: string;
}
