/**
 * What an admin alert email says (HOO-2299). Each email is thin: what happened, in which
 * organization and project, who did it, and a dashboard link. It never carries an address, an
 * amount or a secret; the dashboard shows those to someone signed in.
 */
import { z } from "zod";

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

/** Everything an email renders, snapshotted when the alert is written. */
export const adminAlertDetailsSchema = z.object({
  organizationName: z.string(),
  project: z.object({ id: z.string(), name: z.string(), environment: z.string() }).nullable(),
  /** Who did it: a member's name or email, an API key's name, or null for SDP itself. */
  actor: z.string().nullable(),
  /** What it was done to: the member, key or wallet, when the event names one. */
  subject: z.string().nullable(),
  previousRole: z.string().optional(),
  role: z.string().optional(),
  enabled: z.boolean().optional(),
  counts: moneyMovementCountsSchema.optional(),
  windowStart: z.string().optional(),
  windowEnd: z.string().optional(),
});

export type AdminAlertDetails = z.infer<typeof adminAlertDetailsSchema>;

export interface AdminAlertEmailContent {
  subject: string;
  body: string;
}

const MONEY_COUNT_LABELS: Record<keyof MoneyMovementCounts, [string, string]> = {
  transfers: ["transfer", "transfers"],
  batches: ["batch payout", "batch payouts"],
  recurringCollections: ["recurring collection", "recurring collections"],
  paymentRequestSettlements: ["payment request settlement", "payment request settlements"],
  deposits: ["deposit", "deposits"],
  offramps: ["off-ramp", "off-ramps"],
  onramps: ["on-ramp", "on-ramps"],
};

function plural(count: number, [one, many]: [string, string]): string {
  return `${count} ${count === 1 ? one : many}`;
}

function moneyMovementSummary(counts: MoneyMovementCounts): string {
  return (Object.keys(MONEY_COUNT_LABELS) as (keyof MoneyMovementCounts)[])
    .filter((key) => counts[key] > 0)
    .map((key) => plural(counts[key], MONEY_COUNT_LABELS[key]))
    .join(", ");
}

/** The headline (used in the subject) and the sentence that opens the body. */
function describe(
  kind: AdminAlertKind,
  details: AdminAlertDetails
): { headline: string; sentence: string } {
  const subject = details.subject ?? "someone";
  switch (kind) {
    case "member_invited":
      return {
        headline: "Member invited",
        sentence: `An invitation to join as ${details.role ?? "a member"} was sent.`,
      };
    case "member_joined":
      return {
        headline: "Member joined",
        sentence: `${subject} joined as ${details.role ?? "a member"}.`,
      };
    case "member_role_changed":
      return {
        headline: "Member role changed",
        sentence: `${subject}'s role changed from ${details.previousRole ?? "unknown"} to ${details.role ?? "unknown"}.`,
      };
    case "member_removed":
      return { headline: "Member removed", sentence: `${subject} no longer has access.` };
    case "api_key_created":
      return { headline: "API key created", sentence: `The API key ${subject} was created.` };
    case "api_key_rotated":
      return {
        headline: "API key rotated",
        sentence: `The API key ${subject} was rotated; its replacement is a new secret.`,
      };
    case "api_key_revoked":
      return { headline: "API key revoked", sentence: `The API key ${subject} was revoked.` };
    case "custody_connected":
      return {
        headline: "Custody connection added",
        sentence: `A custody connection (${subject}) was connected.`,
      };
    case "custody_disconnected":
      return {
        headline: "Custody connection removed",
        sentence: `A custody connection (${subject}) was deactivated.`,
      };
    case "custody_wallet_created":
      return { headline: "Wallet created", sentence: `A custody wallet (${subject}) was created.` };
    case "custody_wallet_removed":
      return { headline: "Wallet removed", sentence: `A custody wallet (${subject}) was removed.` };
    case "ip_allowlist_changed":
      return {
        headline: "IP allowlist changed",
        sentence: "The organization's API IP allowlist changed.",
      };
    case "alert_emails_changed":
      return details.enabled
        ? { headline: "Alert emails on", sentence: "Alert emails to admins were turned on." }
        : {
            headline: "Alert emails off",
            sentence:
              "Alert emails were turned off. Admins will no longer be emailed when money moves or the organization changes.",
          };
    case "mainnet_entitlement_changed":
      return details.enabled
        ? {
            headline: "Mainnet enabled",
            sentence: "The organization can now use mainnet projects.",
          }
        : {
            headline: "Mainnet disabled",
            sentence: "The organization can no longer use mainnet projects.",
          };
    case "money_movement": {
      const summary = details.counts ? moneyMovementSummary(details.counts) : "";
      return {
        headline: "Money moved",
        sentence: `Money moved: ${summary || "see the dashboard"}.`,
      };
    }
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

/**
 * The email for one alert.
 *
 * @param input.kind - What happened.
 * @param input.details - The alert's snapshot.
 * @param input.occurredAt - When it happened (ISO 8601).
 * @param input.dashboardOrigin - The dashboard's origin, for the link.
 */
export function adminAlertEmail(input: {
  kind: AdminAlertKind;
  details: AdminAlertDetails;
  occurredAt: string;
  dashboardOrigin: string;
}): AdminAlertEmailContent {
  const { kind, details } = input;
  const { headline, sentence } = describe(kind, details);
  const lines = [sentence, "", `Organization: ${details.organizationName}`];
  if (details.project) {
    lines.push(`Project: ${details.project.name} (${details.project.environment})`);
  }
  if (kind === "money_movement") {
    lines.push(
      `Between: ${details.windowStart ?? input.occurredAt} and ${details.windowEnd ?? ""}`
    );
  } else {
    lines.push(`By: ${details.actor ?? "SDP"}`, `When: ${input.occurredAt}`);
  }
  lines.push(
    "",
    `Review it in the dashboard: ${input.dashboardOrigin}${dashboardPath(kind, details)}`,
    "",
    `You get this email because you are an admin of ${details.organizationName}.`
  );
  if (kind === "money_movement") {
    lines.push(
      "An organization admin can turn off money movement emails in organization settings."
    );
  } else {
    lines.push("If you did not expect this, review your organization's members and API keys.");
  }
  return { subject: `[SDP] ${headline} in ${details.organizationName}`, body: lines.join("\n") };
}
