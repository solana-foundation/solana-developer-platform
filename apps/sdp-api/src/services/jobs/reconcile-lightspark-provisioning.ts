import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import type { RampRuntimeContext } from "@sdp/payments/ramps/types";
import { getDb } from "@/db";
import { createPostgresCounterpartyProviderAccountsRepository } from "@/db/repositories";
import { createKVStoreSet } from "@/runtime/kv-redis";
import { getLogger } from "@/runtime/logger";
import { type AuditIntent, type AuditLogEntry, AuditService } from "@/services/audit.service";
import type { Env } from "@/types/env";

/**
 * Reconciles Lightspark provisioning against the sealed audit ledger.
 *
 * A crash between the provider mutation and its audit outcome leaves a durable
 * intent with no outcome and, for payout accounts, a live pending reservation
 * row that 409s every later submission for the corridor. The sweep closes both
 * gaps: it binds a provider account that exists to its reservation (repair) or
 * archives the reservation when the provider never received it (flag), then
 * resolves the matched intent so the integrity gate stops counting it. Each
 * candidate is only eligible after a grace window, so an in-flight request is
 * never swept.
 */

export const LIGHTSPARK_PROVISIONING_RECONCILE_GRACE_MS = 15 * 60 * 1000;
export const LIGHTSPARK_PROVISIONING_RECONCILE_BATCH = 25;

/** Overrides for the sweep's eligibility window (tests and manual backfills). */
export interface LightsparkProvisioningReconcileOptions {
  graceMs?: number;
}

const LIGHTSPARK_PAYOUT_ACTION = "lightspark_payout_account_created";
const LIGHTSPARK_CUSTOMER_ACTION = "lightspark_customer_created";

interface StalePendingLightsparkAccountRow {
  id: string;
  organization_id: string;
  project_id: string;
  counterparty_id: string;
  provider_customer_reference: string | null;
  fiat_currency: string;
}

interface UnresolvedLightsparkIntentRow {
  intent_id: string;
  organization_id: string | null;
  metadata: Record<string, unknown>;
}

/**
 * Reconciles stale pending Lightspark payout reservations and unresolved
 * Lightspark provisioning intents.
 *
 * @param env - Process environment used for database and provider access.
 * @param options - Overrides for the eligibility grace window.
 * @returns The number of candidates repaired, flagged, or resolved.
 */
export async function reconcileLightsparkProvisioning(
  env: Env,
  options: LightsparkProvisioningReconcileOptions = {}
): Promise<number> {
  const graceMs = options.graceMs ?? LIGHTSPARK_PROVISIONING_RECONCILE_GRACE_MS;
  const cutoff = new Date(Date.now() - graceMs).toISOString();
  let touched = 0;
  touched += await reconcileStalePendingAccounts(env, cutoff);
  touched += await reconcileUnresolvedPayoutIntents(env, cutoff);
  touched += await reconcileUnresolvedCustomerIntents(env, cutoff);
  return touched;
}

/**
 * Sweeps pending Lightspark payout reservations older than the grace window.
 * A provider account that exists is bound to the reservation (repair); a
 * reservation the provider never received is archived (flag). When an
 * unresolved provisioning intent names the row, it is resolved with the
 * triage outcome.
 *
 * @param env - Process environment used for database and provider access.
 * @param cutoff - ISO timestamp before which a reservation is stale.
 * @returns The number of rows triaged.
 */
async function reconcileStalePendingAccounts(env: Env, cutoff: string): Promise<number> {
  const logger = getLogger();
  const stale = await getDb(env)
    .prepare(
      `SELECT id, organization_id, project_id, counterparty_id,
              provider_customer_reference, fiat_currency
       FROM counterparty_provider_accounts
       WHERE provider = 'lightspark'
         AND kind = 'payout_account'
         AND status = 'active'
         AND external_account_reference IS NULL
         AND created_at::timestamptz < ?::timestamptz
       ORDER BY created_at
       LIMIT ${LIGHTSPARK_PROVISIONING_RECONCILE_BATCH}`
    )
    .bind(cutoff)
    .all<StalePendingLightsparkAccountRow>();
  let touched = 0;
  for (const row of stale.results ?? []) {
    if (await triagePendingAccount(env, row)) {
      touched += 1;
    }
  }
  if (touched > 0) {
    logger.info({ count: touched }, "[lightspark provisioning] pending reservations triaged");
  }
  return touched;
}

/**
 * Triages one stale pending reservation: reads the provider state for the
 * platform id the row minted, repairs a match by completing the row, flags
 * the absence by archiving it, and resolves the row's unresolved intent.
 *
 * @param env - Process environment used for database and provider access.
 * @param row - The stale pending reservation row.
 * @returns Whether the row was touched.
 */
async function triagePendingAccount(
  env: Env,
  row: StalePendingLightsparkAccountRow
): Promise<boolean> {
  const logger = getLogger();
  const accounts = createPostgresCounterpartyProviderAccountsRepository(getDb(env));
  const scope = {
    organizationId: row.organization_id,
    projectId: row.project_id,
    counterpartyId: row.counterparty_id,
    provider: "lightspark" as const,
  };
  // A concurrent request may have completed or archived the row after the
  // sweep listed it; the fresh read decides whether triage still applies.
  const current = await accounts.getExternalAccountById({ ...scope, id: row.id });
  if (current === null) {
    return false;
  }
  if (current.external_account_reference !== null) {
    await resolvePendingAccountIntent(env, row, {
      reconciled: true,
      externalAccountReference: current.external_account_reference,
    });
    return false;
  }
  const mode = await projectEnvironment(env, row.project_id);
  if (mode === null || row.provider_customer_reference === null) {
    logger.error(
      { provider_account_id: row.id, project_id: row.project_id },
      "[lightspark provisioning] pending reservation cannot be triaged; leaving it in place"
    );
    return false;
  }
  const ctx: RampRuntimeContext = {
    env: env as unknown as Record<string, string | undefined>,
    mode,
  };
  let found: { id: string; status: string } | null = null;
  try {
    found = await RAMP_PROVIDER_CLIENTS.lightspark.findExternalAccountByPlatformId(ctx, {
      customerId: row.provider_customer_reference,
      currency: row.fiat_currency,
      platformAccountId: row.id,
    });
  } catch (error) {
    logger.error(
      { provider_account_id: row.id, error: describeError(error) },
      "[lightspark provisioning] provider lookup failed; retrying next tick"
    );
    return false;
  }
  if (found !== null) {
    const repaired = await accounts.completeExternalAccount({
      ...scope,
      id: row.id,
      externalAccountReference: found.id,
      providerStatus: found.status,
    });
    if (repaired !== null) {
      logger.warn(
        {
          provider_account_id: row.id,
          external_account_reference: found.id,
        },
        "[lightspark provisioning] repaired an orphaned provider payout account into its reservation"
      );
    }
    await resolvePendingAccountIntent(env, row, {
      reconciled: true,
      externalAccountReference: found.id,
    });
    return repaired !== null;
  }
  const archived = await accounts.archiveExternalAccount({ ...scope, id: row.id });
  if (archived !== null) {
    logger.warn(
      { provider_account_id: row.id },
      "[lightspark provisioning] archived a stale pending reservation the provider never received"
    );
    await resolvePendingAccountIntent(env, row, {
      reconciled: true,
      providerOutcome: "unverified",
      providerAccountFound: false,
    });
    return true;
  }
  // The archive refuses rows that already carry a provider reference: a
  // concurrent request completed the reservation while the provider lookup
  // was in flight. Re-read the row and resolve its intent from that state
  // instead of recording a failure for a link that durably exists.
  const settled = await accounts.getExternalAccountById({ ...scope, id: row.id });
  if (settled !== null && settled.external_account_reference !== null) {
    await resolvePendingAccountIntent(env, row, {
      reconciled: true,
      externalAccountReference: settled.external_account_reference,
    });
    return true;
  }
  return false;
}

/**
 * Sweeps unresolved Lightspark payout-account intents older than the grace
 * window. The request path resolves an intent only with a best-effort outcome
 * write, so a payout whose local row completed while that write failed — or
 * after a crash before it — leaves the intent unresolved, and the pending
 * sweep no longer sees the row because it carries its provider reference. The
 * sweep reads the row the intent names: a durable completion resolves the
 * intent as success, an archived or missing row resolves it as a failed
 * attempt with providerOutcome "unverified", and a still-pending row is left
 * for the pending sweep.
 *
 * @param env - Process environment used for database access.
 * @param cutoff - ISO timestamp before which an intent is stale.
 * @returns The number of intents resolved.
 */
async function reconcileUnresolvedPayoutIntents(env: Env, cutoff: string): Promise<number> {
  const logger = getLogger();
  const intents = await getDb(env)
    .prepare(
      `SELECT i.resource_id AS intent_id, i.organization_id,
              CASE
                WHEN i.metadata IS NOT NULL AND pg_input_is_valid(i.metadata, 'jsonb')
                THEN i.metadata::jsonb
                ELSE NULL
              END AS metadata
       FROM audit_logs i
       WHERE i.resource_type = 'audit_ledger'
         AND CASE
           WHEN i.metadata IS NOT NULL AND pg_input_is_valid(i.metadata, 'jsonb')
           THEN i.metadata::jsonb ->> 'auditPhase' = 'intent'
                AND i.metadata::jsonb -> 'target' -> 'metadata' ->> 'provider' = 'lightspark'
                AND i.metadata::jsonb -> 'target' -> 'metadata' ->> 'action' = ?
           ELSE false
         END
         AND i.created_at::timestamptz < ?::timestamptz
         AND NOT EXISTS (
           SELECT 1 FROM audit_logs o
           WHERE CASE
             WHEN o.metadata IS NOT NULL AND pg_input_is_valid(o.metadata, 'jsonb')
             THEN o.metadata::jsonb ->> 'auditPhase' = 'outcome'
                  AND o.metadata::jsonb ->> 'auditIntentId' = i.resource_id
             ELSE false
           END
         )
       ORDER BY i.created_at
       LIMIT ${LIGHTSPARK_PROVISIONING_RECONCILE_BATCH}`
    )
    .bind(LIGHTSPARK_PAYOUT_ACTION, cutoff)
    .all<UnresolvedLightsparkIntentRow>();
  let touched = 0;
  for (const intent of intents.results ?? []) {
    if (await reconcilePayoutIntent(env, intent)) {
      touched += 1;
    }
  }
  if (touched > 0) {
    logger.info({ count: touched }, "[lightspark provisioning] payout intents resolved");
  }
  return touched;
}

/**
 * Reconciles one unresolved payout-account intent from the local row it names.
 *
 * @param env - Process environment used for database and ledger access.
 * @param intent - The unresolved intent row.
 * @returns Whether the intent was resolved.
 */
async function reconcilePayoutIntent(
  env: Env,
  intent: UnresolvedLightsparkIntentRow
): Promise<boolean> {
  const logger = getLogger();
  const target = readIntentTarget(intent.metadata);
  const metadata = target?.metadata ?? {};
  const localRowId = typeof metadata.localRowId === "string" ? metadata.localRowId : undefined;
  const counterpartyId =
    typeof metadata.counterpartyId === "string" ? metadata.counterpartyId : undefined;
  const organizationId =
    typeof metadata.organizationId === "string"
      ? metadata.organizationId
      : (intent.organization_id ?? undefined);
  const projectId = typeof metadata.projectId === "string" ? metadata.projectId : undefined;
  if (
    localRowId === undefined ||
    counterpartyId === undefined ||
    organizationId === undefined ||
    projectId === undefined
  ) {
    logger.error(
      { intent_id: intent.intent_id },
      "[lightspark provisioning] payout intent lacks its tenant scope; leaving it for operators"
    );
    return false;
  }
  const row = await createPostgresCounterpartyProviderAccountsRepository(
    getDb(env)
  ).getExternalAccountById({
    organizationId,
    projectId,
    counterpartyId,
    provider: "lightspark",
    id: localRowId,
  });
  if (row !== null && row.status === "active" && row.external_account_reference === null) {
    // Still an in-flight or untriaged reservation: the pending sweep owns it.
    return false;
  }
  if (row !== null && row.external_account_reference !== null) {
    await resolveIntent(env, intent, {
      action: LIGHTSPARK_PAYOUT_ACTION,
      status: "success",
      metadata: {
        reconciledBy: "lightspark_provisioning_reconciler",
        reconciled: true,
        externalAccountReference: row.external_account_reference,
      },
    });
    return true;
  }
  // Archived or missing: the provisioning never durably completed locally.
  await resolveIntent(env, intent, {
    action: LIGHTSPARK_PAYOUT_ACTION,
    status: "failure",
    metadata: {
      reconciledBy: "lightspark_provisioning_reconciler",
      providerOutcome: "unverified",
      providerAccountFound: false,
    },
  });
  return true;
}

/**
 * Resolves the unresolved provisioning intent that names a pending row, when
 * one exists. The reconciliation outcome documents what the sweep observed so
 * the integrity gate stops counting the intent.
 *
 * @param env - Process environment used for ledger access.
 * @param row - The triaged pending reservation row.
 * @param outcomeMetadata - The reconciliation evidence to append.
 */
async function resolvePendingAccountIntent(
  env: Env,
  row: StalePendingLightsparkAccountRow,
  outcomeMetadata: Record<string, unknown>
): Promise<void> {
  const unresolved = await findUnresolvedIntent(getDb(env), row.id, LIGHTSPARK_PAYOUT_ACTION);
  if (unresolved !== null) {
    await resolveIntent(env, unresolved, {
      action: LIGHTSPARK_PAYOUT_ACTION,
      status: outcomeMetadata.providerAccountFound === false ? "failure" : "success",
      metadata: { reconciledBy: "lightspark_provisioning_reconciler", ...outcomeMetadata },
    });
  }
}

/**
 * Sweeps unresolved Lightspark customer-provisioning intents older than the
 * grace window. A link row that already exists resolves the intent; otherwise
 * the provider is asked for the customer keyed by the counterparty's platform
 * id: a match is linked (repair), an absence resolves the intent as a failed
 * attempt with nothing orphaned.
 *
 * @param env - Process environment used for database and provider access.
 * @param cutoff - ISO timestamp before which an intent is stale.
 * @returns The number of intents resolved.
 */
async function reconcileUnresolvedCustomerIntents(env: Env, cutoff: string): Promise<number> {
  const logger = getLogger();
  const intents = await getDb(env)
    .prepare(
      `SELECT i.resource_id AS intent_id, i.organization_id,
              CASE
                WHEN i.metadata IS NOT NULL AND pg_input_is_valid(i.metadata, 'jsonb')
                THEN i.metadata::jsonb
                ELSE NULL
              END AS metadata
       FROM audit_logs i
       WHERE i.resource_type = 'audit_ledger'
         AND CASE
           WHEN i.metadata IS NOT NULL AND pg_input_is_valid(i.metadata, 'jsonb')
           THEN i.metadata::jsonb ->> 'auditPhase' = 'intent'
                AND i.metadata::jsonb -> 'target' -> 'metadata' ->> 'provider' = 'lightspark'
                AND i.metadata::jsonb -> 'target' -> 'metadata' ->> 'action' = ?
           ELSE false
         END
         AND i.created_at::timestamptz < ?::timestamptz
         AND NOT EXISTS (
           SELECT 1 FROM audit_logs o
           WHERE CASE
             WHEN o.metadata IS NOT NULL AND pg_input_is_valid(o.metadata, 'jsonb')
             THEN o.metadata::jsonb ->> 'auditPhase' = 'outcome'
                  AND o.metadata::jsonb ->> 'auditIntentId' = i.resource_id
             ELSE false
           END
         )
       ORDER BY i.created_at
       LIMIT ?`
    )
    .bind(LIGHTSPARK_CUSTOMER_ACTION, cutoff, LIGHTSPARK_PROVISIONING_RECONCILE_BATCH)
    .all<UnresolvedLightsparkIntentRow>();
  let touched = 0;
  for (const intent of intents.results ?? []) {
    if (await reconcileCustomerIntent(env, intent)) {
      touched += 1;
    }
  }
  if (touched > 0) {
    logger.info({ count: touched }, "[lightspark provisioning] customer intents resolved");
  }
  return touched;
}

/**
 * Reconciles one unresolved customer intent: links the provider customer the
 * counterparty's platform id resolves to, or resolves the intent as a failed
 * attempt when the provider never created it.
 *
 * @param env - Process environment used for database and provider access.
 * @param intent - The unresolved intent row.
 * @returns Whether the intent was resolved.
 */
async function reconcileCustomerIntent(
  env: Env,
  intent: UnresolvedLightsparkIntentRow
): Promise<boolean> {
  const logger = getLogger();
  const target = readIntentTarget(intent.metadata);
  const counterpartyId = target?.resourceId;
  const metadata = target?.metadata ?? {};
  const organizationId =
    typeof metadata.organizationId === "string" ? metadata.organizationId : intent.organization_id;
  const projectId = typeof metadata.projectId === "string" ? metadata.projectId : undefined;
  if (
    typeof counterpartyId !== "string" ||
    typeof organizationId !== "string" ||
    typeof projectId !== "string"
  ) {
    logger.error(
      { intent_id: intent.intent_id },
      "[lightspark provisioning] customer intent lacks its tenant scope; leaving it for operators"
    );
    return false;
  }
  const accounts = createPostgresCounterpartyProviderAccountsRepository(getDb(env));
  const linked = await accounts.getProviderAccount({
    organizationId,
    projectId,
    counterpartyId,
    provider: "lightspark",
  });
  if (linked !== null) {
    await resolveIntent(env, intent, {
      action: LIGHTSPARK_CUSTOMER_ACTION,
      status: "success",
      metadata: {
        reconciledBy: "lightspark_provisioning_reconciler",
        providerCustomerReference: linked.provider_customer_reference,
      },
    });
    return true;
  }
  const mode = await projectEnvironment(env, projectId);
  if (mode === null) {
    logger.error(
      { intent_id: intent.intent_id, project_id: projectId },
      "[lightspark provisioning] customer intent project is missing; leaving it for operators"
    );
    return false;
  }
  const ctx: RampRuntimeContext = {
    env: env as unknown as Record<string, string | undefined>,
    mode,
  };
  let customer: { id: string } | null = null;
  try {
    customer = await RAMP_PROVIDER_CLIENTS.lightspark.lookupCustomerByPlatformId(ctx, {
      platformCustomerId: counterpartyId,
    });
  } catch (error) {
    logger.error(
      { intent_id: intent.intent_id, error: describeError(error) },
      "[lightspark provisioning] customer lookup failed; retrying next tick"
    );
    return false;
  }
  if (customer === null) {
    await resolveIntent(env, intent, {
      action: LIGHTSPARK_CUSTOMER_ACTION,
      status: "failure",
      metadata: {
        reconciledBy: "lightspark_provisioning_reconciler",
        providerOutcome: "unverified",
        providerCustomerFound: false,
      },
    });
    return true;
  }
  await accounts.upsertProviderAccount({
    organizationId,
    projectId,
    counterpartyId,
    provider: "lightspark",
    providerCustomerReference: customer.id,
  });
  logger.warn(
    { intent_id: intent.intent_id, counterparty_id: counterpartyId },
    "[lightspark provisioning] linked an orphaned provider customer to its counterparty"
  );
  await resolveIntent(env, intent, {
    action: LIGHTSPARK_CUSTOMER_ACTION,
    status: "success",
    metadata: {
      reconciledBy: "lightspark_provisioning_reconciler",
      providerCustomerReference: customer.id,
    },
  });
  return true;
}

/**
 * Finds the newest unresolved provisioning intent naming a local row id.
 *
 * @param db - Database client for ledger access.
 * @param localRowId - The provider-account row id the intent names.
 * @param action - The provisioning action the intent admitted.
 * @returns The unresolved intent row, or null when none remains.
 */
async function findUnresolvedIntent(
  db: ReturnType<typeof getDb>,
  localRowId: string,
  action: string
): Promise<UnresolvedLightsparkIntentRow | null> {
  return db
    .prepare(
      `SELECT i.resource_id AS intent_id, i.organization_id,
              CASE
                WHEN i.metadata IS NOT NULL AND pg_input_is_valid(i.metadata, 'jsonb')
                THEN i.metadata::jsonb
                ELSE NULL
              END AS metadata
       FROM audit_logs i
       WHERE i.resource_type = 'audit_ledger'
         AND CASE
           WHEN i.metadata IS NOT NULL AND pg_input_is_valid(i.metadata, 'jsonb')
           THEN i.metadata::jsonb ->> 'auditPhase' = 'intent'
                AND i.metadata::jsonb -> 'target' -> 'metadata' ->> 'provider' = 'lightspark'
                AND i.metadata::jsonb -> 'target' -> 'metadata' ->> 'action' = ?
                AND i.metadata::jsonb -> 'target' -> 'metadata' ->> 'localRowId' = ?
           ELSE false
         END
         AND NOT EXISTS (
           SELECT 1 FROM audit_logs o
           WHERE CASE
             WHEN o.metadata IS NOT NULL AND pg_input_is_valid(o.metadata, 'jsonb')
             THEN o.metadata::jsonb ->> 'auditPhase' = 'outcome'
                  AND o.metadata::jsonb ->> 'auditIntentId' = i.resource_id
             ELSE false
           END
         )
       ORDER BY i.created_at DESC
       LIMIT 1`
    )
    .bind(action, localRowId)
    .first<UnresolvedLightsparkIntentRow>();
}

/**
 * Appends the reconciliation outcome for an unresolved intent through the
 * fail-closed system writer, so the ledger pair is complete again.
 *
 * @param env - Process environment used for ledger access.
 * @param intent - The unresolved intent row.
 * @param outcome - The action, status, and reconciliation evidence to append.
 */
async function resolveIntent(
  env: Env,
  intent: UnresolvedLightsparkIntentRow,
  outcome: { action: string; status: "success" | "failure"; metadata: Record<string, unknown> }
): Promise<void> {
  const target = readIntentTarget(intent.metadata);
  const entry: AuditLogEntry = {
    organizationId: intent.organization_id ?? undefined,
    action: "update",
    resourceType: "counterparty",
    resourceId: typeof target?.resourceId === "string" ? target.resourceId : undefined,
    metadata: target?.metadata,
  };
  const auditIntent: AuditIntent = { id: intent.intent_id, entry };
  const service = new AuditService(getDb(env), createKVStoreSet(env).cache);
  const persisted = await service.completeCriticalSystem(auditIntent, {
    status: outcome.status,
    metadata: outcome.metadata,
  });
  if (!persisted) {
    getLogger().error(
      { intent_id: intent.intent_id },
      "[lightspark provisioning] reconciliation outcome persistence failed; intent stays unresolved"
    );
  }
}

interface IntentTarget {
  resourceId?: unknown;
  metadata?: Record<string, unknown>;
}

/**
 * Reads the admitted target of an intent row.
 *
 * @param metadata - The intent row's metadata blob.
 * @returns The target object, or undefined when the row is malformed.
 */
function readIntentTarget(metadata: Record<string, unknown>): IntentTarget | undefined {
  const target = metadata.target;
  if (target === null || typeof target !== "object") {
    return undefined;
  }
  return target as IntentTarget;
}

/**
 * Resolves a project's ramp environment for provider calls.
 *
 * @param env - Process environment used for database access.
 * @param projectId - The project that owns the provisioning scope.
 * @returns The environment mode, or null when the project is missing.
 */
async function projectEnvironment(
  env: Env,
  projectId: string
): Promise<"sandbox" | "production" | null> {
  const row = await getDb(env)
    .prepare("SELECT environment FROM projects WHERE id = ?")
    .bind(projectId)
    .first<{ environment: string }>();
  if (row === null) {
    return null;
  }
  return row.environment === "production" ? "production" : "sandbox";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
