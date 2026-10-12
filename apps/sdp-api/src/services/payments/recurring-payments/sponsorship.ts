import { z } from "zod";
import { type DatabaseExecutor, getDb } from "@/db";
import { AppError, conflict } from "@/lib/errors";
import { getDeploymentMode, type SdpDeploymentMode } from "@/lib/runtime-env";
import type {
  SponsorshipAccountingIdentity,
  SponsorshipContinuity,
} from "@/services/sponsorship.service";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";

const attemptTables = {
  activation: "payment_recurring_payment_activation_attempts",
  lifecycle: "payment_recurring_payment_lifecycle_attempts",
  update: "payment_recurring_payment_update_attempts",
  collection: "payment_subscription_collection_attempts",
} as const;
const messageStages: Record<string, string> = {
  authorization_setup: "authorize_subscription",
  cancel_old: "cancel_old_subscription",
};
const consistentAccountingLink = `l.organization_id = r.organization_id
  AND l.project_id IS NOT DISTINCT FROM r.project_id AND l.legacy_actor_id = r.actor_id AND r.actor_type = 'wallet'
  AND l.accounting_identity->>'reservationId' = r.id
  AND l.accounting_identity->'attempt' = to_jsonb(r.attempt)
  AND l.accounting_identity->>'organizationId' = r.organization_id
  AND (l.accounting_identity->>'projectId') IS NOT DISTINCT FROM r.project_id
  AND l.accounting_identity->>'network' = r.network
  AND l.accounting_identity->>'environment' = r.product_environment
  AND l.accounting_identity->'actor'->>'type' = r.actor_type
  AND l.accounting_identity->'actor'->>'id' = r.actor_id
  AND l.accounting_identity->>'transactionDigest' = r.transaction_digest
  AND l.accounting_identity->>'feePayer' = r.fee_payer
  AND l.accounting_identity->>'providerConfigFingerprint' = r.provider_config_fingerprint`;
const confirmedFailureProof = `l.confirmed_failure_signature IS NOT NULL AND (
  (l.deployment_mode = 'self_hosted' AND l.submission_signature = l.confirmed_failure_signature)
  OR (l.deployment_mode = 'managed' AND r.status = 'committed'
    AND r.signature = l.confirmed_failure_signature AND ${consistentAccountingLink}))`;

export async function findConfirmedRecurringSponsorshipFailures(
  db: DatabaseExecutor,
  input: {
    organizationId: string;
    projectId: string;
    attemptId: string;
  }
) {
  return (
    await db
      .prepare(`SELECT split_part(l.message_key, ':', 1) AS message_key, l.confirmed_failure_signature
    FROM payment_recurring_sponsorship_links l LEFT JOIN sponsorship_budget_reservations r ON r.id = l.reservation_id
    WHERE l.organization_id = ? AND l.project_id = ? AND l.attempt_kind = 'update' AND l.attempt_id = ?
      AND ${confirmedFailureProof}`)
      .bind(input.organizationId, input.projectId, input.attemptId)
      .all<{ message_key: string; confirmed_failure_signature: string }>()
  ).results;
}

export interface RecurringSponsorshipMessage {
  attemptKind: keyof typeof attemptTables;
  attemptId: string;
  recurringPaymentId: string;
  messageKey: string;
}

export class ConfirmedSubscriptionFailure extends AppError {
  constructor(
    readonly signature: string,
    message: string,
    readonly messageKey?: string
  ) {
    super("TRANSACTION_FAILED", message);
  }
}

export async function recordConfirmedRecurringSponsorshipFailure(
  db: DatabaseExecutor,
  input: {
    organizationId: string;
    projectId: string;
    attemptKind: RecurringSponsorshipMessage["attemptKind"];
    attemptId: string;
    error: Error;
  }
): Promise<void> {
  if (!(input.error instanceof ConfirmedSubscriptionFailure) || !input.error.messageKey) return;
  await db
    .prepare(`UPDATE payment_recurring_sponsorship_links l SET confirmed_failure_signature = ?
    WHERE l.organization_id = ? AND l.project_id = ? AND l.attempt_kind = ? AND l.attempt_id = ?
      AND split_part(l.message_key, ':', 1) = ?
      AND ((l.deployment_mode = 'self_hosted' AND l.submission_signature = ?) OR EXISTS (SELECT 1 FROM sponsorship_budget_reservations r
        WHERE r.id = l.reservation_id AND r.signature = ? AND r.status <> 'charged_unknown' AND ${consistentAccountingLink}))`)
    .bind(
      input.error.signature,
      input.organizationId,
      input.projectId,
      input.attemptKind,
      input.attemptId,
      input.error.messageKey,
      input.error.signature,
      input.error.signature
    )
    .run();
}

export async function hasPendingRecurringSponsorship(input: {
  env: Env;
  organizationId: string;
  projectId: string;
  attemptId: string;
}): Promise<boolean> {
  const pending = await getDb(input.env)
    .prepare(
      `SELECT l.attempt_id FROM payment_recurring_sponsorship_links l
       JOIN sponsorship_budget_reservations r ON r.id = l.reservation_id
      WHERE l.organization_id = ? AND l.project_id = ? AND l.attempt_kind = 'update'
        AND l.attempt_id = ? AND r.status IN ('reserved', 'signed', 'submitted', 'charged_unknown')
      LIMIT 1`
    )
    .bind(input.organizationId, input.projectId, input.attemptId)
    .first<{ attempt_id: string }>();
  return pending !== null;
}

const accountingIdentitySchema = z.object({
  reservationId: z.string().min(1),
  attempt: z.number().int().positive(),
  network: z.enum(["devnet", "mainnet"]),
  environment: z.enum(["sandbox", "production"]),
  organizationId: z.string().min(1),
  projectId: z.string().nullable(),
  actor: z.object({
    type: z.enum(["api_key", "project", "user", "wallet"]),
    id: z.string().min(1),
  }),
  transactionDigest: z.string().min(1),
  feePayer: z.string().min(1),
  providerConfigFingerprint: z.string().min(1),
});

const linkSchema = z.object({
  message_key: z.string(),
  deployment_mode: z.enum(["managed", "self_hosted"]),
  legacy_actor_id: z.string().min(1),
  custody_wallet_id: z.string().min(1),
  reservation_id: z.string().nullable(),
  accounting_identity: accountingIdentitySchema.nullable(),
  admission_started_at: z.coerce.date().nullable(),
  confirmed_failure_signature: z.string().nullable(),
  submission_signature: z.string().nullable(),
});

function hasKnownSelfHostedSubmission(link: z.infer<typeof linkSchema> | null): boolean {
  return (
    link?.deployment_mode === "self_hosted" &&
    link.submission_signature !== null &&
    link.confirmed_failure_signature === null
  );
}

function assertReleasedAccountingLinkConsistent(link: Record<string, unknown> | null): void {
  if (link?.reservation_status === "released" && link.accounting_link_consistent !== true) {
    throw conflict("Released recurring sponsorship accounting evidence conflicts");
  }
}

/** Slots are created with a new fenced attempt, never inferred from schedule age. */
export async function initializeRecurringSponsorshipMessages(
  db: DatabaseExecutor,
  input: Omit<RecurringSponsorshipMessage, "messageKey"> & {
    organizationId: string;
    projectId: string;
    deploymentMode: SdpDeploymentMode;
    messages: { key: string; custodyWalletId: string; providerWalletId: string }[];
  }
): Promise<void> {
  const table = attemptTables[input.attemptKind];
  const collection = input.attemptKind === "collection";
  const owner = collection
    ? "a.subscription_id = current.subscription_id AND a.due_at = current.due_at"
    : "a.recurring_payment_id = current.recurring_payment_id";
  const unlinkedStage = collection ? "AND a.transfer_id IS NOT NULL" : "AND a.stage = ?";
  const cycle = collection ? `AND a.due_at = (SELECT due_at FROM ${table} WHERE id = ?)` : "";
  for (const message of input.messages) {
    const stage =
      input.attemptKind === "lifecycle" ? "submit" : (messageStages[message.key] ?? message.key);
    const unlinked = await db
      .prepare(
        `SELECT a.id FROM ${table} a JOIN ${table} current ON current.id = ?
        WHERE ${owner} AND a.organization_id = ? AND a.project_id = ? AND a.id <> current.id
          AND a.status <> 'confirmed' ${unlinkedStage}
          AND NOT EXISTS (SELECT 1 FROM payment_recurring_sponsorship_links l
            WHERE l.attempt_kind = ? AND l.attempt_id = a.id AND split_part(l.message_key, ':', 1) = ?)
        LIMIT 1`
      )
      .bind(
        input.attemptId,
        input.organizationId,
        input.projectId,
        ...(collection ? [] : [stage]),
        input.attemptKind,
        message.key
      )
      .first<{ id: string }>();
    if (unlinked)
      throw conflict("Previous recurring sponsorship outcome has no accounting evidence");
    const previous = await db
      .prepare(
        `SELECT l.*, r.status AS reservation_status,
          COALESCE(${consistentAccountingLink}, false) AS accounting_link_consistent
         FROM payment_recurring_sponsorship_links l
         JOIN ${table} a ON a.id = l.attempt_id
         LEFT JOIN sponsorship_budget_reservations r ON r.id = l.reservation_id
        WHERE l.organization_id = ? AND l.project_id = ? AND l.recurring_payment_id = ?
          AND l.attempt_kind = ? AND split_part(l.message_key, ':', 1) = ? AND a.status <> 'confirmed'
          AND NOT COALESCE(${confirmedFailureProof}, false) ${cycle}
        ORDER BY l.created_at DESC LIMIT 1`
      )
      .bind(
        input.organizationId,
        input.projectId,
        input.recurringPaymentId,
        input.attemptKind,
        message.key,
        ...(input.attemptKind === "collection" ? [input.attemptId] : [])
      )
      .first<Record<string, unknown>>();
    assertReleasedAccountingLinkConsistent(previous);
    const retained =
      previous &&
      (previous.deployment_mode === "self_hosted" ||
        (previous.accounting_identity && previous.reservation_status !== "released"))
        ? linkSchema.parse(previous)
        : null;
    // A saved signature permits observation; the carried start marker still fences another send.
    if (
      previous?.admission_started_at &&
      previous.accounting_identity === null &&
      !hasKnownSelfHostedSubmission(retained)
    ) {
      throw conflict("Previous recurring sponsorship admission has unresolved accounting evidence");
    }
    await db
      .prepare(
        `INSERT INTO payment_recurring_sponsorship_links
       (recurring_payment_id, organization_id, project_id, attempt_kind, attempt_id, message_key,
        deployment_mode, legacy_actor_id, custody_wallet_id, reservation_id, accounting_identity,
        confirmed_failure_signature, submission_signature, admission_started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?)
       ON CONFLICT (attempt_kind, attempt_id, message_key) DO NOTHING`
      )
      .bind(
        input.recurringPaymentId,
        input.organizationId,
        input.projectId,
        input.attemptKind,
        input.attemptId,
        message.key,
        retained?.deployment_mode ?? input.deploymentMode,
        retained?.legacy_actor_id ?? message.providerWalletId,
        retained?.custody_wallet_id ?? message.custodyWalletId,
        retained?.reservation_id ?? null,
        retained?.accounting_identity ? JSON.stringify(retained.accounting_identity) : null,
        retained?.confirmed_failure_signature ?? null,
        retained?.submission_signature ?? null,
        retained?.admission_started_at?.toISOString() ?? null
      )
      .run();
  }
}

async function readOwnedMessage(
  db: DatabaseExecutor,
  input: RecurringSponsorshipMessage & {
    organizationId: string;
    projectId: string;
    sourceWallet: CustodyWallet;
  },
  lock: boolean,
  latest = false
) {
  const table = attemptTables[input.attemptKind];
  const collection = input.attemptKind === "collection";
  const relation = collection
    ? "a.subscription_id = p.subscription_id AND a.due_at = p.next_collection_due_at"
    : "a.recurring_payment_id = p.id";
  const exactRole =
    input.attemptKind === "update" && input.messageKey.split(":")[0] !== "cancel_old"
      ? "CASE WHEN 'sourceCustodyWalletId' = ANY(a.changed_fields) THEN a.new_source_custody_wallet_id ELSE p.source_custody_wallet_id END"
      : "p.source_custody_wallet_id";
  const parentStatus = collection
    ? "p.status = 'active'"
    : input.attemptKind === "activation"
      ? "p.status = 'activating'"
      : input.attemptKind === "update"
        ? "p.status = 'updating'"
        : "p.status IN ('canceling', 'resuming')";
  const stage = collection ? "a.due_at" : "a.stage";
  const row = await db
    .prepare(
      `SELECT l.*, a.updated_at AS attempt_updated_at, p.updated_at AS payment_updated_at, ${stage} AS stage
       FROM payment_recurring_sponsorship_links l
       JOIN ${table} a ON a.id = l.attempt_id
       JOIN payment_recurring_payments p ON p.id = l.recurring_payment_id AND ${relation}
      WHERE l.organization_id = ? AND l.project_id = ? AND l.recurring_payment_id = ?
        AND l.attempt_kind = ? AND l.attempt_id = ?
        AND ${latest ? "split_part(l.message_key, ':', 1) = ?" : "l.message_key = ?"}
        AND a.organization_id = l.organization_id AND a.project_id = l.project_id
        AND p.organization_id = l.organization_id AND p.project_id = l.project_id
        AND a.status IN ('processing', 'recoverable') AND ${parentStatus}
        AND ${exactRole} = l.custody_wallet_id AND l.custody_wallet_id = ?
        ORDER BY l.created_at DESC LIMIT 1 ${lock ? "FOR UPDATE OF p, a, l" : ""}`
    )
    .bind(
      input.organizationId,
      input.projectId,
      input.recurringPaymentId,
      input.attemptKind,
      input.attemptId,
      input.messageKey,
      input.sourceWallet.id
    )
    .first<Record<string, unknown>>();
  if (!row) throw conflict("Recurring sponsorship message is unresolved or changed concurrently");
  return {
    ...linkSchema.parse(row),
    ...z
      .object({ attempt_updated_at: z.string(), payment_updated_at: z.string(), stage: z.string() })
      .parse(row),
  };
}

/** Foundation validates reservation/security evidence; this module fences its real owner. */
export async function recurringSponsorshipContinuity(
  input: RecurringSponsorshipMessage & {
    env: Env;
    organizationId: string;
    projectId: string;
    sourceWallet: CustodyWallet;
  }
): Promise<SponsorshipContinuity & { messageKey: string }> {
  const stored = await getDb(input.env).transaction(async (tx) => {
    const owned = await readOwnedMessage(tx, input, true, true);
    if (!owned.confirmed_failure_signature) return owned;
    const reconciled = await tx
      .prepare(`SELECT l.message_key FROM payment_recurring_sponsorship_links l
        LEFT JOIN sponsorship_budget_reservations r ON l.reservation_id = r.id
        WHERE l.attempt_kind = ? AND l.attempt_id = ? AND l.message_key = ?
          AND ${confirmedFailureProof}`)
      .bind(input.attemptKind, input.attemptId, owned.message_key)
      .first<{ message_key: string }>();
    if (!reconciled) return owned;
    const messageKey = `${input.messageKey}:${owned.confirmed_failure_signature}`;
    await tx
      .prepare(`INSERT INTO payment_recurring_sponsorship_links
      (recurring_payment_id, organization_id, project_id, attempt_kind, attempt_id, message_key,
       deployment_mode, legacy_actor_id, custody_wallet_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (attempt_kind, attempt_id, message_key) DO NOTHING`)
      .bind(
        input.recurringPaymentId,
        input.organizationId,
        input.projectId,
        input.attemptKind,
        input.attemptId,
        messageKey,
        owned.deployment_mode,
        owned.legacy_actor_id,
        owned.custody_wallet_id
      )
      .run();
    return readOwnedMessage(tx, { ...input, messageKey }, true);
  });
  const ownedInput = { ...input, messageKey: stored.message_key };
  if (stored.admission_started_at && stored.reservation_id === null) {
    throw conflict("Recurring sponsorship admission has unresolved accounting evidence");
  }
  if (stored.deployment_mode !== getDeploymentMode(input.env)) {
    throw conflict("Recurring sponsorship deployment mode conflicts with retained evidence");
  }
  return {
    messageKey: stored.message_key,
    deploymentMode: stored.deployment_mode,
    legacyActor: { type: "wallet", id: stored.legacy_actor_id },
    exactActor: { type: "wallet", id: stored.custody_wallet_id },
    admission: stored.reservation_id ? "continue_only" : "legacy_new",
    ...(stored.reservation_id ? { reservationId: stored.reservation_id } : {}),
    async persistAccountingIdentity(identity: SponsorshipAccountingIdentity) {
      await getDb(input.env).transaction(async (tx) => {
        const current = await readOwnedMessage(tx, ownedInput, true);
        if (
          current.attempt_updated_at !== stored.attempt_updated_at ||
          current.payment_updated_at !== stored.payment_updated_at ||
          current.stage !== stored.stage ||
          identity.organizationId !== input.organizationId ||
          identity.projectId !== input.projectId ||
          identity.actor.type !== "wallet" ||
          identity.actor.id !== current.legacy_actor_id ||
          (current.reservation_id !== null && current.reservation_id !== identity.reservationId)
        ) {
          throw conflict("Recurring sponsorship accounting owner changed concurrently");
        }
        const updated = await tx
          .prepare(
            `UPDATE payment_recurring_sponsorship_links
              SET reservation_id = ?, accounting_identity = ?::jsonb
            WHERE organization_id = ? AND project_id = ? AND recurring_payment_id = ?
              AND attempt_kind = ? AND attempt_id = ? AND message_key = ?
              AND (accounting_identity IS NULL OR accounting_identity = ?::jsonb)
            RETURNING attempt_id`
          )
          .bind(
            identity.reservationId,
            JSON.stringify(identity),
            input.organizationId,
            input.projectId,
            input.recurringPaymentId,
            input.attemptKind,
            input.attemptId,
            ownedInput.messageKey,
            JSON.stringify(identity)
          )
          .first<{ attempt_id: string }>();
        if (!updated) throw conflict("Recurring sponsorship accounting evidence conflicts");
      });
    },
  };
}

export async function startRecurringSponsorshipAdmission(
  input: RecurringSponsorshipMessage & {
    env: Env;
    organizationId: string;
    projectId: string;
    sourceWallet: CustodyWallet;
    reservationId?: string;
  }
): Promise<void> {
  await getDb(input.env).transaction(async (tx) => {
    const owned = await readOwnedMessage(tx, input, true);
    if (owned.reservation_id !== (input.reservationId ?? null))
      throw conflict("Recurring sponsorship accounting changed before admission");
    const started = await tx
      .prepare(`UPDATE payment_recurring_sponsorship_links SET admission_started_at = NOW()
      WHERE organization_id = ? AND project_id = ? AND attempt_kind = ? AND attempt_id = ? AND message_key = ?
        AND (admission_started_at IS NULL OR reservation_id IS NOT NULL) RETURNING attempt_id`)
      .bind(
        input.organizationId,
        input.projectId,
        input.attemptKind,
        input.attemptId,
        input.messageKey
      )
      .first<{ attempt_id: string }>();
    if (!started)
      throw conflict("Recurring sponsorship admission already started without accounting linkage");
  });
}

export async function persistRecurringSponsorshipSubmission(
  input: RecurringSponsorshipMessage & {
    env: Env;
    organizationId: string;
    projectId: string;
    sourceWallet: CustodyWallet;
    signature: string;
  }
): Promise<void> {
  await getDb(input.env).transaction(async (tx) => {
    await readOwnedMessage(tx, input, true);
    const saved = await tx
      .prepare(`UPDATE payment_recurring_sponsorship_links SET submission_signature = ?
      WHERE organization_id = ? AND project_id = ? AND attempt_kind = ? AND attempt_id = ? AND message_key = ?
        AND (submission_signature IS NULL OR submission_signature = ?) RETURNING attempt_id`)
      .bind(
        input.signature,
        input.organizationId,
        input.projectId,
        input.attemptKind,
        input.attemptId,
        input.messageKey,
        input.signature
      )
      .first<{ attempt_id: string }>();
    if (!saved)
      throw conflict("Recurring sponsored signature conflicts with retained message evidence");
  });
}
