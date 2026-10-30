/**
 * An organization's one-time request for mainnet (HOO-2427). An admin declares the organization's
 * jurisdiction and accepts the SDP Terms and Conditions in the same submit; SDP records both and
 * emails its alias. Approval is not here: an operator sets `enableProductionProject` in Clerk, the
 * webhook syncs it into the organization's settings, and `state` reads `approved` from that alone.
 */
import { COUNTRIES, type CountryCode } from "@sdp/types/countries";
import { type MainnetAccess, type MainnetAccessState, SDP_TERMS } from "@sdp/types/mainnet-access";
import type { DatabaseExecutor } from "@/db/client";
import { conflict } from "@/lib/errors";
import { createSystemAuditService } from "@/services/audit.service";
import {
  mainnetAccessEmailConfig,
  sendMainnetAccessRequestEmail,
} from "@/services/mainnet-access-email";
import type { Env } from "@/types/env";

export interface MainnetAccessRow {
  organization_id: string;
  country_code: string;
  terms_version: string;
  terms_accepted_at: string;
  terms_accepted_by_user_id: string;
  requested_at: string;
  requested_by_user_id: string;
  notified_at: string | null;
}

const MAINNET_ACCESS_COLUMNS = `organization_id, country_code, terms_version, terms_accepted_at,
  terms_accepted_by_user_id, requested_at, requested_by_user_id, notified_at`;

export function countryName(code: string): string {
  return COUNTRIES.find((country) => country.code === code)?.name ?? code;
}

function isCountryCode(code: string): code is CountryCode {
  return COUNTRIES.some((country) => country.code === code);
}

export function readMainnetAccessRow(
  db: DatabaseExecutor,
  organizationId: string
): Promise<MainnetAccessRow | null> {
  return db
    .prepare(
      `SELECT ${MAINNET_ACCESS_COLUMNS} FROM organization_mainnet_access WHERE organization_id = ?`
    )
    .bind(organizationId)
    .first<MainnetAccessRow>();
}

function mainnetAccessState(row: MainnetAccessRow | null, entitled: boolean): MainnetAccessState {
  if (entitled) return "approved";
  return row ? "pending" : "not_requested";
}

export function toMainnetAccess(
  env: Env,
  row: MainnetAccessRow | null,
  entitled: boolean
): MainnetAccess {
  return {
    state: mainnetAccessState(row, entitled),
    countryCode: row && isCountryCode(row.country_code) ? row.country_code : null,
    termsAcceptance: row
      ? {
          version: row.terms_version,
          acceptedAt: row.terms_accepted_at,
          acceptedByUserId: row.terms_accepted_by_user_id,
        }
      : null,
    request: row
      ? {
          requestedAt: row.requested_at,
          requestedByUserId: row.requested_by_user_id,
          notified: row.notified_at !== null,
        }
      : null,
    currentTerms: { version: SDP_TERMS.version, url: SDP_TERMS.url },
    contactEmail: mainnetAccessEmailConfig(env)?.to ?? null,
  };
}

export interface MainnetAccessSubmission {
  organizationId: string;
  userId: string;
  countryCode: CountryCode;
  termsVersion: string;
}

/**
 * Records the request, once per organization. A second submit is refused, except while the
 * email to the alias has not gone out: then it changes nothing and the caller resends it.
 *
 * @returns The stored row, and whether this submit created it.
 * @throws CONFLICT when the terms version is not the current one, or the request was already sent.
 */
export async function recordMainnetAccessRequest(
  tx: DatabaseExecutor,
  submission: MainnetAccessSubmission
): Promise<{ row: MainnetAccessRow; created: boolean }> {
  if (submission.termsVersion !== SDP_TERMS.version) {
    throw conflict("The Terms and Conditions changed; review the current version and accept it", {
      currentTermsVersion: SDP_TERMS.version,
    });
  }
  const inserted = await tx
    .prepare(
      `INSERT INTO organization_mainnet_access (
         organization_id, country_code, terms_version, terms_accepted_at,
         terms_accepted_by_user_id, requested_at, requested_by_user_id
       ) VALUES (?, ?, ?, sdp_iso_now(), ?, sdp_iso_now(), ?)
       ON CONFLICT (organization_id) DO NOTHING
       RETURNING ${MAINNET_ACCESS_COLUMNS}`
    )
    .bind(
      submission.organizationId,
      submission.countryCode,
      submission.termsVersion,
      submission.userId,
      submission.userId
    )
    .first<MainnetAccessRow>();
  if (inserted) return { row: inserted, created: true };

  const existing = await tx
    .prepare(
      `SELECT ${MAINNET_ACCESS_COLUMNS} FROM organization_mainnet_access
       WHERE organization_id = ? FOR UPDATE`
    )
    .bind(submission.organizationId)
    .first<MainnetAccessRow>();
  if (!existing || existing.notified_at !== null) {
    throw conflict("This organization already requested mainnet access");
  }
  return { row: existing, created: false };
}

/** Emails the alias for a recorded request and marks it sent. */
export async function notifyMainnetAccessRequest(
  env: Env,
  db: DatabaseExecutor,
  row: MainnetAccessRow
): Promise<MainnetAccessRow> {
  const context = await db
    .prepare(
      `SELECT o.name AS organization_name, u.email AS requester_email, u.name AS requester_name
       FROM organizations o
       LEFT JOIN users u ON u.id = ?
       WHERE o.id = ?`
    )
    .bind(row.requested_by_user_id, row.organization_id)
    .first<{
      organization_name: string;
      requester_email: string | null;
      requester_name: string | null;
    }>();

  await sendMainnetAccessRequestEmail(env, {
    organizationId: row.organization_id,
    organizationName: context?.organization_name ?? row.organization_id,
    requester: {
      userId: row.requested_by_user_id,
      email: context?.requester_email ?? null,
      name: context?.requester_name ?? null,
    },
    countryCode: row.country_code,
    countryName: countryName(row.country_code),
    termsVersion: row.terms_version,
    termsAcceptedAt: row.terms_accepted_at,
    requestedAt: row.requested_at,
  });

  const updated = await db
    .prepare(
      `UPDATE organization_mainnet_access
       SET notified_at = COALESCE(notified_at, sdp_iso_now()), updated_at = sdp_iso_now()
       WHERE organization_id = ?
       RETURNING ${MAINNET_ACCESS_COLUMNS}`
    )
    .bind(row.organization_id)
    .first<MainnetAccessRow>();
  return updated ?? row;
}

export interface MainnetAccessCorrection {
  organizationId: string;
  /** `set-country` corrects the declared jurisdiction; `reset` clears the request entirely. */
  operation: "set-country" | "reset";
  countryCode?: CountryCode;
  operator: string;
  reason: string;
  ticket: string;
}

/**
 * The operator's correction of a request, when an organization writes to the alias about a
 * wrong jurisdiction or asks to start over (`pnpm -C apps/sdp-api mainnet-access`). It never
 * grants mainnet: that stays Clerk's `enableProductionProject`. Audited with the change.
 *
 * @returns The row after the change; null after a reset.
 */
export async function correctMainnetAccess(
  env: Env,
  input: MainnetAccessCorrection
): Promise<MainnetAccessRow | null> {
  if (input.operator.length > 128 || input.reason.length > 500 || input.ticket.length > 128) {
    throw new Error("Operator, reason, or ticket exceeds its length limit");
  }
  if (input.operation === "set-country" && !input.countryCode) {
    throw new Error("set-country requires a country code");
  }
  return createSystemAuditService(env).logSystemWithin(async (db) => {
    const before = await db
      .prepare(
        `SELECT ${MAINNET_ACCESS_COLUMNS} FROM organization_mainnet_access
         WHERE organization_id = ? FOR UPDATE`
      )
      .bind(input.organizationId)
      .first<MainnetAccessRow>();
    if (!before) throw new Error("This organization has not requested mainnet access");

    let after: MainnetAccessRow | null = null;
    if (input.operation === "reset") {
      await db
        .prepare("DELETE FROM organization_mainnet_access WHERE organization_id = ?")
        .bind(input.organizationId)
        .run();
    } else {
      after = await db
        .prepare(
          `UPDATE organization_mainnet_access
           SET country_code = ?, updated_at = sdp_iso_now()
           WHERE organization_id = ?
           RETURNING ${MAINNET_ACCESS_COLUMNS}`
        )
        .bind(input.countryCode, input.organizationId)
        .first<MainnetAccessRow>();
    }
    return {
      result: after,
      entry: {
        action: input.operation === "reset" ? ("delete" as const) : ("update" as const),
        resourceType: "organization" as const,
        resourceId: input.organizationId,
        organizationId: input.organizationId,
        status: "success" as const,
        metadata: {
          event: "mainnet_access_corrected",
          operation: input.operation,
          before: { countryCode: before.country_code, termsVersion: before.terms_version },
          ...(after ? { after: { countryCode: after.country_code } } : {}),
          operator: input.operator,
          reason: input.reason,
          ticket: input.ticket,
        },
      },
    };
  });
}
