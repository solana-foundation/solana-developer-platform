/**
 * What an admin alert email says (HOO-2299). Each email is thin: what happened, in which
 * organization and project, who did it, and a dashboard link. It never carries an address, an
 * amount or a secret; the dashboard shows those to someone signed in.
 */
import { SDP_ENVIRONMENTS, type SdpEnvironment } from "@sdp/types/api-keys";
import { ORGANIZATION_ROLES } from "@sdp/types/roles";
import { z } from "zod";
import type { EmailContent, EmailDetail } from "@/services/email-layout";

export const CONFIG_ALERT_KINDS = [
  "member_invited",
  "member_joined",
  "member_role_changed",
  "member_removed",
  "api_key_created",
  "api_key_rotated",
  "api_key_revoked",
  "custody_connected",
  "custody_disconnected",
  "custody_wallet_created",
  "custody_wallet_removed",
  "ip_allowlist_changed",
  "alert_emails_changed",
  "mainnet_entitlement_changed",
] as const;

export const ADMIN_ALERT_KINDS = [...CONFIG_ALERT_KINDS, "money_movement"] as const;

export type ConfigAlertKind = (typeof CONFIG_ALERT_KINDS)[number];
export type AdminAlertKind = (typeof ADMIN_ALERT_KINDS)[number];

/** Movement counts in one project's digest window; a batch counts once, whatever its size. */
export const moneyMovementCountsSchema = z.object({
  transfers: z.number().int().nonnegative(),
  batches: z.number().int().nonnegative(),
  recurringCollections: z.number().int().nonnegative(),
  paymentRequestSettlements: z.number().int().nonnegative(),
  deposits: z.number().int().nonnegative(),
  offramps: z.number().int().nonnegative(),
  onramps: z.number().int().nonnegative(),
});

export type MoneyMovementCounts = z.infer<typeof moneyMovementCountsSchema>;

/** The project an alert is about, as its email names it. */
export const alertProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  environment: z.enum(SDP_ENVIRONMENTS),
});

/** Everything an email renders, snapshotted when the alert is written. */
export const adminAlertDetailsSchema = z.object({
  organizationName: z.string(),
  project: alertProjectSchema.nullable(),
  /** Who did it: a member's name or email, an API key's name, or null for SDP itself. */
  actor: z.string().nullable(),
  /** What it was done to: the member, key or wallet, when the event names one. */
  subject: z.string().nullable(),
  previousRole: z.enum(ORGANIZATION_ROLES).optional(),
  role: z.enum(ORGANIZATION_ROLES).optional(),
  enabled: z.boolean().optional(),
  counts: moneyMovementCountsSchema.optional(),
  windowStart: z.string().optional(),
  windowEnd: z.string().optional(),
});

export type AdminAlertDetails = z.infer<typeof adminAlertDetailsSchema>;

/** A money digest's details: its counts and window are required, so a partial one fails loudly. */
const moneyAlertDetailsSchema = adminAlertDetailsSchema.extend({
  counts: moneyMovementCountsSchema,
  windowStart: z.string(),
  windowEnd: z.string(),
});

export interface AdminAlertEmail {
  subject: string;
  content: EmailContent;
}

/** Each count's label, in the order an email lists them. */
const MONEY_COUNT_LABELS = [
  ["transfers", "Transfers"],
  ["batches", "Batch payouts"],
  ["recurringCollections", "Recurring collections"],
  ["paymentRequestSettlements", "Payment request settlements"],
  ["deposits", "Deposits"],
  ["offramps", "Off-ramps"],
  ["onramps", "On-ramps"],
] as const satisfies readonly (readonly [keyof MoneyMovementCounts, string])[];

const ENVIRONMENT_LABELS = {
  production: "Mainnet",
  sandbox: "Devnet",
} as const satisfies Record<SdpEnvironment, string>;

const ROLE_LABELS = {
  admin: "Admin",
  member: "Member",
  viewer: "Viewer",
} as const satisfies Record<(typeof ORGANIZATION_ROLES)[number], string>;

const TIME_FORMAT = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

const CLOCK_FORMAT = new Intl.DateTimeFormat("en-GB", { timeStyle: "short", timeZone: "UTC" });

function utc(iso: string): string {
  return `${TIME_FORMAT.format(new Date(iso))} UTC`;
}

/** A money window, such as "30 Oct 2026, 10:00 to 10:01 UTC". */
function utcWindow(start: string, end: string): string {
  return `${TIME_FORMAT.format(new Date(start))} to ${CLOCK_FORMAT.format(new Date(end))} UTC`;
}

function role(value: AdminAlertDetails["role"]): string {
  if (!value) throw new Error("A member alert has no role");
  return ROLE_LABELS[value];
}

/** The alert's heading (also its subject) and the one sentence under it. */
function describe(
  kind: AdminAlertKind,
  details: AdminAlertDetails
): { heading: string; summary: string } {
  const subject = details.subject ?? "Someone";
  const organization = details.organizationName;
  switch (kind) {
    case "member_invited":
      return {
        heading: "Member invited",
        summary: `Someone was invited to join ${organization} as ${role(details.role).toLowerCase()}.`,
      };
    case "member_joined":
      return { heading: "Member joined", summary: `${subject} joined ${organization}.` };
    case "member_role_changed":
      return {
        heading: "Member role changed",
        summary: `${subject} is now ${role(details.role).toLowerCase()} in ${organization}.`,
      };
    case "member_removed":
      return {
        heading: "Member removed",
        summary: `${subject} no longer has access to ${organization}.`,
      };
    case "api_key_created":
      return { heading: "API key created", summary: `A new API key, ${subject}, was created.` };
    case "api_key_rotated":
      return {
        heading: "API key rotated",
        summary: `The API key ${subject} was rotated, so a new secret is now in use.`,
      };
    case "api_key_revoked":
      return { heading: "API key revoked", summary: `The API key ${subject} was revoked.` };
    case "custody_connected":
      return {
        heading: "Custody connected",
        summary: `A ${subject} custody connection was added.`,
      };
    case "custody_disconnected":
      return {
        heading: "Custody disconnected",
        summary: `A ${subject} custody connection was deactivated.`,
      };
    case "custody_wallet_created":
      return { heading: "Wallet created", summary: `A new ${subject} custody wallet was created.` };
    case "custody_wallet_removed":
      return { heading: "Wallet removed", summary: `A ${subject} custody wallet was removed.` };
    case "ip_allowlist_changed":
      return {
        heading: "IP allowlist changed",
        summary: `The IP addresses ${organization}'s API keys may be used from changed.`,
      };
    case "alert_emails_changed":
      return details.enabled
        ? {
            heading: "Alert emails on",
            summary: `Alert emails for ${organization} were turned on.`,
          }
        : {
            heading: "Alert emails off",
            summary: `Alert emails for ${organization} were turned off. Admins will no longer be emailed about money movement or organization changes.`,
          };
    case "mainnet_entitlement_changed":
      return details.enabled
        ? { heading: "Mainnet enabled", summary: `${organization} can now use mainnet projects.` }
        : {
            heading: "Mainnet disabled",
            summary: `${organization} can no longer use mainnet projects.`,
          };
    case "money_movement":
      return {
        heading: "Money movement",
        summary: `New money movement started in ${details.project?.name ?? organization}.`,
      };
    default: {
      const unreachable: never = kind;
      throw new Error(`Unhandled admin alert kind: ${String(unreachable)}`);
    }
  }
}

/** The dashboard page an alert links to, relative to the dashboard origin. */
function dashboardPath(kind: AdminAlertKind, details: AdminAlertDetails): string {
  const projectId = details.project?.id;
  if (kind.startsWith("member_")) return "/members";
  if (!projectId) return "/dashboard";
  if (kind === "money_movement") return `/dashboard/${projectId}/payments/transactions`;
  if (kind.startsWith("api_key_")) return `/dashboard/${projectId}/api-keys`;
  if (kind.startsWith("custody_")) return `/dashboard/${projectId}/wallets`;
  return `/dashboard/${projectId}`;
}

/** The labelled rows under the summary: where, who or how much, and when. */
function detailRows(
  kind: AdminAlertKind,
  details: AdminAlertDetails,
  occurredAt: string
): EmailDetail[] {
  const rows: EmailDetail[] = [{ label: "Organization", value: details.organizationName }];
  if (details.project) {
    rows.push(
      { label: "Project", value: details.project.name },
      { label: "Network", value: ENVIRONMENT_LABELS[details.project.environment] }
    );
  }
  if (kind === "money_movement") {
    const money = moneyAlertDetailsSchema.parse(details);
    for (const [key, label] of MONEY_COUNT_LABELS) {
      if (money.counts[key] > 0) rows.push({ label, value: String(money.counts[key]) });
    }
    rows.push({ label: "Started", value: utcWindow(money.windowStart, money.windowEnd) });
    return rows;
  }
  if (kind === "member_role_changed") {
    rows.push({
      label: "Role",
      value: `${role(details.previousRole)} to ${role(details.role)}`,
    });
  }
  rows.push(
    { label: "By", value: details.actor ?? "SDP" },
    { label: "When", value: utc(occurredAt) }
  );
  return rows;
}

/**
 * The email for one alert. The dashboard link is SDP's own page on its own origin, never built
 * from customer input; every other field is escaped by the layout.
 *
 * @param input.kind - What happened.
 * @param input.details - The alert's snapshot.
 * @param input.occurredAt - When it happened (ISO 8601).
 * @param input.dashboardOrigin - The dashboard's https origin, for the link.
 */
export function adminAlertEmail(input: {
  kind: AdminAlertKind;
  details: AdminAlertDetails;
  occurredAt: string;
  dashboardOrigin: string;
}): AdminAlertEmail {
  const { kind, details } = input;
  const { heading, summary } = describe(kind, details);
  return {
    subject: `${heading} in ${details.organizationName}`,
    content: {
      preheader: summary,
      heading,
      summary,
      details: detailRows(kind, details, input.occurredAt),
      action: {
        label: "Review in dashboard",
        url: `${input.dashboardOrigin}${dashboardPath(kind, details)}`,
      },
      note: `You get this email because you are an admin of ${details.organizationName}. If you did not expect this change, review your organization's members and API keys. An admin can turn off alert emails in organization settings.`,
    },
  };
}
