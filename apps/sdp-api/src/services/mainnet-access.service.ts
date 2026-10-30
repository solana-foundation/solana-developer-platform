/**
 * An organization's one-time request for mainnet (HOO-2427). An admin declares the organization's
 * jurisdiction and accepts the SDP Terms and Conditions in the same submit; SDP records both and
 * emails its alias. Approval is not here: an operator sets `enableProductionProject` in Clerk, the
 * webhook syncs it into the organization's settings, and `state` reads `approved` from that alone.
 */
import { COUNTRIES, type CountryCode } from "@sdp/types/countries";
import { type MainnetAccess, type MainnetAccessState, SDP_TERMS } from "@sdp/types/mainnet-access";
import type { DatabaseExecutor } from "@/db/client";
import {
  type MainnetAccessClaim,
  MainnetAccessRepository,
  type MainnetAccessRow,
} from "@/db/repositories/mainnet-access.repository";
import { conflict, internalError } from "@/lib/errors";
import { createSystemAuditService } from "@/services/audit.service";
import {
  mainnetAccessEmailConfig,
  sendMainnetAccessRequestEmail,
} from "@/services/mainnet-access-email";
import type { Env } from "@/types/env";

export function countryName(code: CountryCode): string {
  const country = COUNTRIES.find((candidate) => candidate.code === code);
  if (!country) throw internalError(`Country ${code} is missing from the country catalog`);
  return country.name;
}

export function readMainnetAccessRow(
  db: DatabaseExecutor,
  organizationId: string
): Promise<MainnetAccessRow | null> {
  return new MainnetAccessRepository(db).get(organizationId);
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
    countryCode: row ? row.country_code : null,
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

/**
 * Records the request, once per organization. A second submit is refused, except while the
 * email to the alias has not gone out: then it changes nothing and the caller resends the stored
 * request, whatever terms version the submit names, since the stored acceptance is what is sent.
 *
 * @returns The stored row, and whether this submit created it.
 * @throws CONFLICT when a new request names a terms version that is not the current one, or the
 *   request was already sent.
 */
export async function recordMainnetAccessRequest(
  tx: DatabaseExecutor,
  submission: MainnetAccessClaim
): Promise<{ row: MainnetAccessRow; created: boolean }> {
  const repository = new MainnetAccessRepository(tx);
  if (submission.termsVersion === SDP_TERMS.version) {
    const created = await repository.claim(submission);
    if (created) return { row: created, created: true };
  }

  const existing = await repository.get(submission.organizationId, { forUpdate: true });
  if (!existing) {
    throw conflict("The Terms and Conditions changed; review the current version and accept it", {
      currentTermsVersion: SDP_TERMS.version,
    });
  }
  if (existing.notified_at !== null) {
    throw conflict("This organization already requested mainnet access");
  }
  return { row: existing, created: false };
}

/**
 * Emails the alias for a recorded request and marks it sent.
 *
 * @throws CONFLICT when the request was reset while it was being sent.
 */
export async function notifyMainnetAccessRequest(
  env: Env,
  db: DatabaseExecutor,
  row: MainnetAccessRow
): Promise<MainnetAccessRow> {
  const repository = new MainnetAccessRepository(db);
  const context = await repository.emailContext(row);

  await sendMainnetAccessRequestEmail(env, {
    organizationId: row.organization_id,
    organizationName: context.organization_name,
    requester: {
      userId: row.requested_by_user_id,
      email: context.requester_email,
      name: context.requester_name,
    },
    countryCode: row.country_code,
    countryName: countryName(row.country_code),
    termsVersion: row.terms_version,
    termsAcceptedAt: row.terms_accepted_at,
    requestedAt: row.requested_at,
  });

  const notified = await repository.markNotified(row);
  if (!notified) throw conflict("The mainnet access request changed while it was being sent");
  return notified;
}

interface CorrectionAudit {
  operator: string;
  reason: string;
  ticket: string;
}

/** `set-country` corrects the declared jurisdiction; `reset` clears the request entirely. */
export type MainnetAccessCorrection = { organizationId: string } & CorrectionAudit &
  ({ operation: "set-country"; countryCode: CountryCode } | { operation: "reset" });

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
  return createSystemAuditService(env).logSystemWithin(async (db) => {
    const repository = new MainnetAccessRepository(db);
    const before = await repository.get(input.organizationId, { forUpdate: true });
    if (!before) throw new Error("This organization has not requested mainnet access");

    let after: MainnetAccessRow | null = null;
    const metadata: Record<string, unknown> = {
      event: "mainnet_access_corrected",
      operation: input.operation,
      before: { countryCode: before.country_code, termsVersion: before.terms_version },
      operator: input.operator,
      reason: input.reason,
      ticket: input.ticket,
    };
    if (input.operation === "set-country") {
      after = await repository.setCountry(input.organizationId, input.countryCode);
      metadata.after = { countryCode: after.country_code };
    } else {
      await repository.reset(input.organizationId);
    }
    return {
      result: after,
      entry: {
        action: input.operation === "reset" ? ("delete" as const) : ("update" as const),
        resourceType: "organization" as const,
        resourceId: input.organizationId,
        organizationId: input.organizationId,
        status: "success" as const,
        metadata,
      },
    };
  });
}
