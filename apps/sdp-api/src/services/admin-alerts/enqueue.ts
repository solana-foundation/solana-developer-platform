/**
 * Writes admin alerts (HOO-2299) from the rows that already record each event, so no request or
 * money path carries an alert hook of its own:
 *
 * - Configuration changes from the audit ledger, read after a cursor on `ledger_sequence`. The
 *   ledger writes under one lock until its COMMIT, so sequences become visible in order and a
 *   cursor never skips one still in flight.
 * - Money movement from the payment rows, as one digest per project per window. Batches and
 *   recurring collections write no audit entry, and a digest keeps a busy project to one email
 *   per window. A movement row is dated by its transaction's start, so a window closes
 *   `MONEY_WINDOW_GRACE_MS` after it ends, for transactions still open at its end.
 *
 * Each alert is written once per source (`source_key` is unique) with a delivery row per admin,
 * in the transaction that moves its cursor; `deliver.ts` sends them after that commits.
 */
import { ORGANIZATION_ROLES, type OrganizationRole } from "@sdp/types/roles";
import { z } from "zod";
import { type DatabaseExecutor, getDb } from "@/db/client";
import { buildInClause, parsePostgresJson } from "@/db/postgres-utils";
import { getLogger } from "@/runtime/logger";
import type { Env } from "@/types/env";
import type {
  AdminAlertDetails,
  AdminAlertKind,
  ConfigAlertKind,
  MoneyMovementCounts,
} from "./content";

/** Audit entries read per run; a longer backlog drains over the next runs. */
export const AUDIT_ALERT_BATCH = 500;
/** One money digest per project per window: a busy project gets one email a minute at most. */
export const MONEY_WINDOW_MS = 60_000;
/** How long after a window ends its digest is written. */
export const MONEY_WINDOW_GRACE_MS = 30_000;
/** An event older than this when the Worker reaches it emails nobody: it is history, not news. */
export const ADMIN_ALERT_MAX_AGE_MS = 24 * 60 * 60_000;
/**
 * Alerts about a project cover mainnet projects only; devnet is test traffic. Organization-wide
 * changes (members, the allowlist, the entitlement, this setting) have no project and always alert.
 */
const ALERTING_PROJECT_ENVIRONMENT = "production";

interface AuditRow {
  ledger_sequence: string | number;
  organization_id: string;
  user_id: string | null;
  api_key_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  metadata: string | null;
  created_at: string;
}

interface ConfigAlert {
  kind: ConfigAlertKind;
  projectId: string | null;
  /** The member the event is about, named in the email. */
  subjectUserId?: string;
  subject?: string | null;
  previousRole?: OrganizationRole;
  role?: OrganizationRole;
  enabled?: boolean;
}

const auditMetadataSchema = z
  .object({
    auditPhase: z.string().optional(),
    event: z.string().optional(),
    action: z.string().optional(),
    projectId: z.string().optional(),
    userId: z.string().optional(),
    role: z.enum(ORGANIZATION_ROLES).optional(),
    previousRole: z.enum(ORGANIZATION_ROLES).optional(),
    name: z.string().optional(),
    provider: z.string().nullable().optional(),
    enabled: z.boolean().optional(),
    result: z.string().optional(),
    settings: z
      .object({
        allowedIpAddresses: z.unknown().optional(),
        alertEmails: z.boolean().optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

type AuditMetadata = z.infer<typeof auditMetadataSchema>;

/** The audit actions an alert can come from; the rest are never read. */
const ALERTING_AUDIT_ACTIONS = [
  "invite",
  "accept_invite",
  "update",
  "delete",
  "create",
  "check",
  "deactivate",
] as const;

/**
 * An entry's metadata, or null when it is not what its writer is meant to record. That is logged
 * as an error for the entry rather than thrown: the cursor has to move past it, or one bad entry
 * would stop every organization's alerts.
 */
function parseAuditMetadata(row: AuditRow): AuditMetadata | null {
  if (!row.metadata) return {};
  const parsed = auditMetadataSchema.safeParse(parsePostgresJson<unknown>(row.metadata));
  if (parsed.success) return parsed.data;
  getLogger().error(
    {
      event: "sdp_admin_alert_audit_entry_unreadable",
      ledgerSequence: row.ledger_sequence,
      action: row.action,
      resourceType: row.resource_type,
      issues: parsed.error.issues,
    },
    "an audit entry's metadata does not parse, so it raised no admin alert"
  );
  return null;
}

/** An organization update's alerts: the entitlement, or the settings it changed. */
function organizationAlerts(metadata: AuditMetadata): ConfigAlert[] {
  if (metadata.event === "production_entitlement_changed") {
    return [{ kind: "mainnet_entitlement_changed", projectId: null, enabled: metadata.enabled }];
  }
  const alerts: ConfigAlert[] = [];
  if (metadata.settings && "allowedIpAddresses" in metadata.settings) {
    alerts.push({ kind: "ip_allowlist_changed", projectId: null });
  }
  if (metadata.settings?.alertEmails !== undefined) {
    alerts.push({
      kind: "alert_emails_changed",
      projectId: null,
      enabled: metadata.settings.alertEmails,
    });
  }
  return alerts;
}

/**
 * The alerts one audit entry raises; most raise none. An organization update can raise two (an
 * allowlist and the alert-email setting in one request). Entries of critical operations count
 * only as their successful outcome, never as the intent that admitted them; an outcome entry
 * carries its intent's metadata with the outcome's own `event` written over it.
 */
export function configAlertsFromAudit(row: AuditRow): ConfigAlert[] {
  const metadata = parseAuditMetadata(row);
  if (!metadata) return [];
  const projectId = metadata.projectId ?? null;
  const key = `${row.action}:${row.resource_type}`;
  const outcome = metadata.auditPhase === "outcome";
  switch (key) {
    case "invite:invitation":
      return [{ kind: "member_invited", projectId: null, role: metadata.role }];
    case "accept_invite:invitation":
      return [
        {
          kind: "member_joined",
          projectId: null,
          subjectUserId: metadata.userId ?? row.user_id ?? undefined,
          role: metadata.role,
        },
      ];
    case "update:member":
      return metadata.previousRole && metadata.role
        ? [
            {
              kind: "member_role_changed",
              projectId: null,
              subjectUserId: metadata.userId,
              previousRole: metadata.previousRole,
              role: metadata.role,
            },
          ]
        : [];
    case "delete:member":
      return [{ kind: "member_removed", projectId: null, subjectUserId: metadata.userId }];
    case "create:api_key":
      return [{ kind: "api_key_created", projectId, subject: metadata.name ?? row.resource_id }];
    case "update:api_key":
      return metadata.action === "rotate"
        ? [{ kind: "api_key_rotated", projectId, subject: row.resource_id }]
        : [];
    case "delete:api_key":
      return [{ kind: "api_key_revoked", projectId, subject: row.resource_id }];
    case "create:custody_config":
      return [{ kind: "custody_connected", projectId, subject: metadata.provider ?? null }];
    case "check:custody_connection":
      return outcome && metadata.event === "provider_credential_installation_completed"
        ? [{ kind: "custody_connected", projectId, subject: metadata.provider ?? null }]
        : [];
    case "deactivate:custody_connection":
      return outcome && metadata.event === "custody_connection_deactivated"
        ? [{ kind: "custody_disconnected", projectId, subject: metadata.provider ?? null }]
        : [];
    case "create:custody_wallet":
      // An idempotent replay writes a second outcome (`already_recorded`) for the same wallet.
      return outcome && metadata.result === "created"
        ? [{ kind: "custody_wallet_created", projectId, subject: metadata.provider ?? null }]
        : [];
    case "delete:custody_wallet":
      return [{ kind: "custody_wallet_removed", projectId, subject: metadata.provider ?? null }];
    case "update:organization":
      return organizationAlerts(metadata);
    default:
      return [];
  }
}

interface Recipient {
  user_id: string;
  email: string;
}

/** Every active admin of the organization. */
async function organizationAdmins(db: DatabaseExecutor, organizationId: string) {
  return db.queryMany<Recipient>(
    `SELECT u.id AS user_id, u.email
       FROM organization_members om
       JOIN users u ON u.id = om.user_id
      WHERE om.organization_id = ? AND om.role = 'admin' AND om.status = 'active'
        AND u.status = 'active'
      ORDER BY u.id`,
    [organizationId]
  );
}

/** The organization's name, and whether it turned alert emails off (`settings.alertEmails`). */
async function organizationAlerting(db: DatabaseExecutor, organizationId: string) {
  const organization = await db.queryOne<{ name: string; alert_emails: string | null }>(
    `SELECT name, settings::jsonb ->> 'alertEmails' AS alert_emails
       FROM organizations WHERE id = ?`,
    [organizationId]
  );
  return organization
    ? { name: organization.name, alertEmailsOff: organization.alert_emails === "false" }
    : null;
}

/** The table whose row names the project of an entry's resource, for the resources that have one. */
function projectOwnerTable(resourceType: string): "api_keys" | "custody_connections" | null {
  switch (resourceType) {
    case "api_key":
      return "api_keys";
    case "custody_connection":
      return "custody_connections";
    default:
      return null;
  }
}

/**
 * The project an entry is about when its metadata does not name it: an API key's or a custody
 * connection's own row says.
 */
async function resolveProjectId(
  db: DatabaseExecutor,
  row: AuditRow,
  alert: ConfigAlert
): Promise<string | null> {
  if (alert.projectId || !row.resource_id) return alert.projectId;
  const table = projectOwnerTable(row.resource_type);
  if (!table) return null;
  const owner = await db.queryOne<{ project_id: string | null }>(
    `SELECT project_id FROM ${table} WHERE id = ? AND organization_id = ?`,
    [row.resource_id, row.organization_id]
  );
  return owner?.project_id ?? null;
}

/** A person as an email names them: their name, else their email. */
async function userLabel(db: DatabaseExecutor, userId: string): Promise<string | null> {
  const user = await db.queryOne<{ name: string | null; email: string }>(
    "SELECT name, email FROM users WHERE id = ?",
    [userId]
  );
  return user ? (user.name?.trim() ? `${user.name} (${user.email})` : user.email) : null;
}

async function actorLabel(db: DatabaseExecutor, row: AuditRow): Promise<string | null> {
  if (row.user_id) return userLabel(db, row.user_id);
  if (row.api_key_id) {
    const key = await db.queryOne<{ name: string }>(
      "SELECT name FROM api_keys WHERE id = ? AND organization_id = ?",
      [row.api_key_id, row.organization_id]
    );
    return `API key ${key?.name ?? row.api_key_id}`;
  }
  return null;
}

async function projectOf(
  db: DatabaseExecutor,
  organizationId: string,
  projectId: string | null
): Promise<AdminAlertDetails["project"]> {
  if (!projectId) return null;
  const project = await db.queryOne<{ id: string; name: string; environment: string }>(
    "SELECT id, name, environment FROM projects WHERE id = ? AND organization_id = ?",
    [projectId, organizationId]
  );
  return project ?? null;
}

/**
 * Writes one alert and a delivery per recipient, unless its source already has one.
 *
 * @returns Whether the alert is new.
 */
async function insertAlert(
  db: DatabaseExecutor,
  alert: {
    organizationId: string;
    projectId: string | null;
    kind: AdminAlertKind;
    sourceKey: string;
    details: AdminAlertDetails;
    occurredAt: string;
  },
  recipients: readonly Recipient[]
): Promise<boolean> {
  const inserted = await db.queryOne<{ id: string }>(
    `INSERT INTO admin_alerts (id, organization_id, project_id, kind, source_key, details, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?::jsonb, ?)
     ON CONFLICT (source_key) DO NOTHING
     RETURNING id`,
    [
      `aalt_${crypto.randomUUID()}`,
      alert.organizationId,
      alert.projectId,
      alert.kind,
      alert.sourceKey,
      JSON.stringify(alert.details),
      alert.occurredAt,
    ]
  );
  if (!inserted) return false;
  for (const recipient of recipients) {
    await db.execute(
      `INSERT INTO admin_alert_deliveries (alert_id, organization_id, user_id, email)
       VALUES (?, ?, ?, ?)`,
      [inserted.id, alert.organizationId, recipient.user_id, recipient.email]
    );
  }
  return true;
}

async function lockCursor(db: DatabaseExecutor, source: "audit_ledger" | "money"): Promise<number> {
  const cursor = await db.queryOne<{ position: string | number }>(
    "SELECT position FROM admin_alert_cursors WHERE source = ? FOR UPDATE",
    [source]
  );
  if (!cursor) throw new Error(`Admin alert cursor ${source} is missing`);
  return Number(cursor.position);
}

async function moveCursor(
  db: DatabaseExecutor,
  source: "audit_ledger" | "money",
  position: number
) {
  await db.execute(
    "UPDATE admin_alert_cursors SET position = ?, updated_at = sdp_iso_now() WHERE source = ?",
    [position, source]
  );
}

/**
 * Writes the alerts one audit entry raises, each to every admin of its organization.
 *
 * @returns How many alerts were new.
 */
async function writeConfigAlerts(tx: DatabaseExecutor, row: AuditRow): Promise<number> {
  const raised = configAlertsFromAudit(row);
  if (raised.length === 0) return 0;
  const organization = await organizationAlerting(tx, row.organization_id);
  if (!organization) return 0;
  const recipients = await organizationAdmins(tx, row.organization_id);
  const actor = await actorLabel(tx, row);
  let written = 0;
  for (const [index, alert] of raised.entries()) {
    // Turning alerts off is itself emailed, so it can never happen unnoticed.
    if (organization.alertEmailsOff && alert.kind !== "alert_emails_changed") continue;
    const project = await projectOf(
      tx,
      row.organization_id,
      await resolveProjectId(tx, row, alert)
    );
    if (project && project.environment !== ALERTING_PROJECT_ENVIRONMENT) continue;
    const details: AdminAlertDetails = {
      organizationName: organization.name,
      project,
      actor,
      subject: alert.subjectUserId
        ? await userLabel(tx, alert.subjectUserId)
        : (alert.subject ?? null),
      previousRole: alert.previousRole,
      role: alert.role,
      enabled: alert.enabled,
    };
    const inserted = await insertAlert(
      tx,
      {
        organizationId: row.organization_id,
        projectId: project?.id ?? null,
        kind: alert.kind,
        sourceKey: `audit:${row.ledger_sequence}:${index}`,
        details,
        occurredAt: row.created_at,
      },
      recipients
    );
    if (inserted) written += 1;
  }
  return written;
}

/**
 * Reads the audit entries after the cursor and writes their alerts, in one transaction.
 *
 * @returns How many alerts were written, and whether entries remain for the next run.
 */
export async function enqueueConfigAlerts(
  env: Env,
  now: Date = new Date()
): Promise<{ alerts: number; more: boolean }> {
  return getDb(env).transaction(async (tx) => {
    const cursor = await lockCursor(tx, "audit_ledger");
    // The head is read first: an entry committed after it waits for the next run.
    const head = await tx.queryOne<{ head: string | number | null }>(
      "SELECT max(ledger_sequence) AS head FROM audit_logs"
    );
    const headSequence = Number(head?.head ?? 0);
    if (headSequence <= cursor) return { alerts: 0, more: false };
    const rows = await tx.queryMany<AuditRow>(
      `SELECT ledger_sequence, organization_id, user_id, api_key_id, action, resource_type,
              resource_id, metadata, created_at
         FROM audit_logs
        WHERE ledger_sequence > ? AND ledger_sequence <= ?
          AND organization_id IS NOT NULL AND status = 'success'
          AND action IN (${buildInClause(ALERTING_AUDIT_ACTIONS.length)})
        ORDER BY ledger_sequence
        LIMIT ?`,
      [cursor, headSequence, ...ALERTING_AUDIT_ACTIONS, AUDIT_ALERT_BATCH]
    );
    const oldest = now.getTime() - ADMIN_ALERT_MAX_AGE_MS;
    let alerts = 0;
    for (const row of rows) {
      if (Date.parse(row.created_at) >= oldest) alerts += await writeConfigAlerts(tx, row);
    }
    const more = rows.length === AUDIT_ALERT_BATCH;
    const last = rows.at(-1);
    await moveCursor(
      tx,
      "audit_ledger",
      more && last ? Number(last.ledger_sequence) : headSequence
    );
    return { alerts, more };
  });
}

interface MoneyCountRow {
  organization_id: string;
  project_id: string;
  kind: keyof MoneyMovementCounts;
  count: string | number;
}

/**
 * Counts the window's movements per project and kind. A transfer's kind follows the dashboard's
 * (`unified_transactions`); batch chunks are left to the batch row. A transfer that failed
 * without a signature never reached the chain, and a failed batch none of whose chunks did moved
 * nothing, so neither counts. A movement counts when it starts, not when it settles: the email
 * is the early signal of a key moving money, and the dashboard shows how each one ended.
 */
async function moneyCounts(
  db: DatabaseExecutor,
  windowStart: string,
  windowEnd: string
): Promise<MoneyCountRow[]> {
  return db.queryMany<MoneyCountRow>(
    `SELECT organization_id, project_id, kind, count(*) AS count FROM (
       SELECT pt.organization_id, pt.project_id,
              CASE
                WHEN pt.type = 'onramp' THEN 'onramps'
                WHEN pt.type = 'offramp' THEN 'offramps'
                WHEN EXISTS (SELECT 1 FROM payment_subscription_collection_attempts psca
                              WHERE psca.transfer_id = pt.id) THEN 'recurringCollections'
                WHEN EXISTS (SELECT 1 FROM payment_requests pr
                              WHERE pr.fulfilled_by_transfer_id = pt.id) THEN 'paymentRequestSettlements'
                WHEN pt.direction = 'inbound' THEN 'deposits'
                ELSE 'transfers'
              END AS kind
         FROM payment_transfers pt
        WHERE pt.created_at >= ? AND pt.created_at < ?
          AND pt.project_id IS NOT NULL AND pt.type <> 'transfer_batch'
          AND NOT (pt.status = 'failed' AND pt.signature IS NULL)
       UNION ALL
       SELECT b.organization_id, b.project_id, 'batches' AS kind
         FROM payment_transfer_batches b
        WHERE b.created_at >= ? AND b.created_at < ?
          AND NOT (b.status = 'failed' AND NOT EXISTS (
                SELECT 1 FROM payment_transfer_recipients r
                  JOIN payment_transfers chunk ON chunk.id = r.transfer_id
                 WHERE r.batch_id = b.id AND chunk.signature IS NOT NULL))
     ) movements
     GROUP BY organization_id, project_id, kind`,
    [windowStart, windowEnd, windowStart, windowEnd]
  );
}

/**
 * Writes the money digests of every window closed since the cursor, as one window: after a
 * Worker outage the gap is summarized in one email per project rather than lost. The window
 * reaches back at most `ADMIN_ALERT_MAX_AGE_MS`, so a deployment that turns email on long after
 * this migration does not summarize months of history.
 *
 * @returns How many digests were written.
 */
export async function enqueueMoneyAlerts(
  env: Env,
  now: Date = new Date()
): Promise<{ alerts: number }> {
  return getDb(env).transaction(async (tx) => {
    const cursor = await lockCursor(tx, "money");
    const closedUntil =
      Math.floor((now.getTime() - MONEY_WINDOW_GRACE_MS) / MONEY_WINDOW_MS) * MONEY_WINDOW_MS;
    if (closedUntil <= cursor) return { alerts: 0 };
    const windowStart = new Date(
      Math.max(cursor, closedUntil - ADMIN_ALERT_MAX_AGE_MS)
    ).toISOString();
    const windowEnd = new Date(closedUntil).toISOString();

    const byProject = new Map<string, { organizationId: string; counts: MoneyMovementCounts }>();
    for (const row of await moneyCounts(tx, windowStart, windowEnd)) {
      const entry = byProject.get(row.project_id) ?? {
        organizationId: row.organization_id,
        counts: {
          transfers: 0,
          batches: 0,
          recurringCollections: 0,
          paymentRequestSettlements: 0,
          deposits: 0,
          offramps: 0,
          onramps: 0,
        },
      };
      entry.counts[row.kind] += Number(row.count);
      byProject.set(row.project_id, entry);
    }

    let alerts = 0;
    for (const [projectId, { organizationId, counts }] of byProject) {
      const organization = await organizationAlerting(tx, organizationId);
      if (!organization || organization.alertEmailsOff) continue;
      const project = await projectOf(tx, organizationId, projectId);
      if (project?.environment !== ALERTING_PROJECT_ENVIRONMENT) continue;
      const inserted = await insertAlert(
        tx,
        {
          organizationId,
          projectId,
          kind: "money_movement",
          sourceKey: `money:${projectId}:${windowStart}`,
          details: {
            organizationName: organization.name,
            project,
            actor: null,
            subject: null,
            counts,
            windowStart,
            windowEnd,
          },
          occurredAt: windowEnd,
        },
        await organizationAdmins(tx, organizationId)
      );
      if (inserted) alerts += 1;
    }
    await moveCursor(tx, "money", closedUntil);
    return { alerts };
  });
}
