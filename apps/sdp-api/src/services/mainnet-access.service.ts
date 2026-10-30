/**
 * An organization's one-time request for mainnet (HOO-2427). An admin declares the organization's
 * jurisdiction and accepts the SDP Terms and Conditions in the same submit; SDP records both and
 * emails its alias. Approval is not here: an operator sets `enableProductionProject` in Clerk, the
 * webhook syncs it into the organization's settings, and `state` reads `approved` from that alone.
 *
 * The jurisdiction, the acceptance and the request are the organization's own facts, so they are
 * columns on its row (migration 0192); a request exists once `mainnet_requested_at` is set.
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

/** The organization's columns under the names the rest of this module reads. */
const MAINNET_ACCESS_COLUMNS = `id AS organization_id, jurisdiction_country_code AS country_code,
  terms_accepted_version AS terms_version, terms_accepted_at, terms_accepted_by_user_id,
  mainnet_requested_at AS requested_at, mainnet_requested_by_user_id AS requested_by_user_id,
  mainnet_request_notified_at AS notified_at`;

type MainnetAccessColumns = {
  [Column in keyof MainnetAccessRow]: MainnetAccessRow[Column] | null;
} & { organization_id: string };

/** The organization's request, or null when it has not asked (the migration keeps them whole). */
function requestOf(columns: MainnetAccessColumns | null): MainnetAccessRow | null {
  if (
    !columns?.requested_at ||
    !columns.requested_by_user_id ||
    !columns.country_code ||
    !columns.terms_version ||
    !columns.terms_accepted_at ||
    !columns.terms_accepted_by_user_id
  ) {
    return null;
  }
  return {
    organization_id: columns.organization_id,
    country_code: columns.country_code,
    terms_version: columns.terms_version,
    terms_accepted_at: columns.terms_accepted_at,
    terms_accepted_by_user_id: columns.terms_accepted_by_user_id,
    requested_at: columns.requested_at,
    requested_by_user_id: columns.requested_by_user_id,
    notified_at: columns.notified_at,
  };
}

async function readColumns(
  db: DatabaseExecutor,
  organizationId: string,
  forUpdate = false
): Promise<MainnetAccessColumns | null> {
  return db
    .prepare(
      `SELECT ${MAINNET_ACCESS_COLUMNS} FROM organizations WHERE id = ?${forUpdate ? " FOR UPDATE" : ""}`
    )
    .bind(organizationId)
    .first<MainnetAccessColumns>();
}

export function countryName(code: string): string {
  return COUNTRIES.find((country) => country.code === code)?.name ?? code;
}

function isCountryCode(code: string): code is CountryCode {
  return COUNTRIES.some((country) => country.code === code);
}

export async function readMainnetAccessRow(
  db: DatabaseExecutor,
  organizationId: string
): Promise<MainnetAccessRow | null> {
  return requestOf(await readColumns(db, organizationId));
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
  // One statement claims the request, so two admins submitting at once record one of them.
  const recorded = await tx
    .prepare(
      `UPDATE organizations
       SET jurisdiction_country_code = ?, terms_accepted_version = ?,
           terms_accepted_at = sdp_iso_now(), terms_accepted_by_user_id = ?,
           mainnet_requested_at = sdp_iso_now(), mainnet_requested_by_user_id = ?,
           updated_at = sdp_datetime_now()
       WHERE id = ? AND mainnet_requested_at IS NULL
       RETURNING ${MAINNET_ACCESS_COLUMNS}`
    )
    .bind(
      submission.countryCode,
      submission.termsVersion,
      submission.userId,
      submission.userId,
      submission.organizationId
    )
    .first<MainnetAccessColumns>();
  const created = requestOf(recorded);
  if (created) return { row: created, created: true };

  const existing = requestOf(await readColumns(tx, submission.organizationId, true));
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
      `UPDATE organizations
       SET mainnet_request_notified_at = COALESCE(mainnet_request_notified_at, sdp_iso_now())
       WHERE id = ? AND mainnet_requested_at = ?
       RETURNING ${MAINNET_ACCESS_COLUMNS}`
    )
    .bind(row.organization_id, row.requested_at)
    .first<MainnetAccessColumns>();
  return requestOf(updated) ?? row;
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
    const before = requestOf(await readColumns(db, input.organizationId, true));
    if (!before) throw new Error("This organization has not requested mainnet access");

    const after =
      input.operation === "reset"
        ? null
        : requestOf(
            await db
              .prepare(
                `UPDATE organizations
                 SET jurisdiction_country_code = ?, updated_at = sdp_datetime_now()
                 WHERE id = ?
                 RETURNING ${MAINNET_ACCESS_COLUMNS}`
              )
              .bind(input.countryCode, input.organizationId)
              .first<MainnetAccessColumns>()
          );
    if (input.operation === "reset") {
      await db
        .prepare(
          `UPDATE organizations
           SET jurisdiction_country_code = NULL, terms_accepted_version = NULL,
               terms_accepted_at = NULL, terms_accepted_by_user_id = NULL,
               mainnet_requested_at = NULL, mainnet_requested_by_user_id = NULL,
               mainnet_request_notified_at = NULL, updated_at = sdp_datetime_now()
           WHERE id = ?`
        )
        .bind(input.organizationId)
        .run();
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
