/**
 * An organization's one-time request for mainnet (HOO-2427). An admin declares the organization's
 * jurisdiction and accepts the SDP Terms and Conditions in the same submit; SDP records both and
 * emails its alias. Approval is not here: an operator sets `enableProductionProject` in Clerk, the
 * webhook syncs it into the organization's settings, and `state` reads `approved` from that alone.
 */
import { COUNTRY_CODES, countryByCode } from "@sdp/types/countries";
import { type MainnetAccess, type MainnetAccessState, SDP_TERMS } from "@sdp/types/mainnet-access";
import { z } from "zod";
import type { DatabaseExecutor } from "@/db/client";
import {
  type MainnetAccessClaim,
  type MainnetAccessEmailContext,
  MainnetAccessRepository,
  type MainnetAccessRow,
} from "@/db/repositories/mainnet-access.repository";
import { conflict } from "@/lib/errors";
import { createSystemAuditService } from "@/services/audit.service";
import {
  type MainnetAccessRequestEmail,
  mainnetAccessEmailConfig,
  sendMainnetAccessCorrectionEmail,
  sendMainnetAccessRequestEmail,
} from "@/services/mainnet-access-email";
import type { Env } from "@/types/env";

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
    available: mainnetAccessEmailConfig(env) !== null,
    countryCode: row ? row.country_code : null,
    request: row
      ? {
          requestedAt: row.requested_at,
          requestedByUserId: row.requested_by_user_id,
          termsVersion: row.terms_version,
          notified: row.notified_at !== null,
        }
      : null,
    contactEmail: mainnetAccessEmailConfig(env)?.to ?? null,
  };
}

/**
 * Records the request, once per organization. An unsent one is sent with `POST …/notify`, never
 * by submitting again.
 *
 * @throws CONFLICT when the submit names a terms version that is not the current one, or the
 *   organization already asked.
 */
export async function recordMainnetAccessRequest(
  tx: DatabaseExecutor,
  submission: MainnetAccessClaim
): Promise<MainnetAccessRow> {
  if (submission.termsVersion !== SDP_TERMS.version) {
    throw conflict("The Terms and Conditions changed; review the current version and accept it", {
      currentTermsVersion: SDP_TERMS.version,
    });
  }
  const created = await new MainnetAccessRepository(tx).claim(submission);
  if (!created) throw conflict("This organization already requested mainnet access");
  return created;
}

/**
 * The organization's recorded request whose email has not gone out, for `POST …/notify`.
 *
 * @throws CONFLICT when the organization has not asked, or its request was already sent.
 */
export async function unsentMainnetAccessRequest(
  db: DatabaseExecutor,
  organizationId: string
): Promise<MainnetAccessRow> {
  const row = await new MainnetAccessRepository(db).get(organizationId);
  if (!row) throw conflict("This organization has not requested mainnet access");
  if (row.notified_at !== null) throw conflict("This organization's request was already sent");
  return row;
}

/**
 * Emails the alias for a recorded request and marks it sent. A claim saved before the send holds
 * the request, so a second send and an operator's correction wait for it: the email can never
 * arrive after a correction's follow-up, and it describes the request as claimed.
 *
 * @throws CONFLICT when another send holds the request, or it was sent meanwhile.
 */
export async function notifyMainnetAccessRequest(
  env: Env,
  db: DatabaseExecutor,
  organizationId: string
): Promise<MainnetAccessRow> {
  const repository = new MainnetAccessRepository(db);
  const claim = await repository.claimSend(organizationId);
  if (!claim) {
    throw conflict("This organization's request is already being sent; try again in a minute");
  }
  try {
    await sendMainnetAccessRequestEmail(
      env,
      requestEmail(claim.row, await repository.emailContext(claim.row))
    );
  } catch (error) {
    await repository.releaseSend(claim);
    throw error;
  }

  const notified = await repository.markNotified(claim);
  if (!notified) throw conflict("The mainnet access request changed while it was being sent");
  return notified;
}

function requestEmail(
  row: MainnetAccessRow,
  context: MainnetAccessEmailContext
): MainnetAccessRequestEmail {
  return {
    organizationId: row.organization_id,
    organizationName: context.organization_name,
    requester: {
      userId: row.requested_by_user_id,
      email: context.requester_email,
      name: context.requester_name,
    },
    countryCode: row.country_code,
    countryName: countryByCode(row.country_code).name,
    termsVersion: row.terms_version,
    requestedAt: row.requested_at,
  };
}

const correctionFields = {
  organizationId: z.string().trim().min(1),
  operator: z.string().trim().min(1).max(128),
  reason: z.string().trim().min(1).max(500),
  ticket: z.string().trim().min(1).max(128),
};

/** `set-country` corrects the declared jurisdiction; `reset` clears the request entirely. */
export const mainnetAccessCorrectionSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("set-country"),
    countryCode: z.string().trim().toUpperCase().pipe(z.enum(COUNTRY_CODES)),
    ...correctionFields,
  }),
  z.object({ operation: z.literal("reset"), ...correctionFields }),
]);

export type MainnetAccessCorrection = z.infer<typeof mainnetAccessCorrectionSchema>;

export interface MainnetAccessCorrectionResult {
  /** The request after the change; null after a reset. */
  request: MainnetAccessRow | null;
  /** Whether the operator address was told; `not_configured` on a deployment without email. */
  operatorEmail: "sent" | "not_configured";
}

/**
 * The operator's correction of a request, when an organization writes to the alias about a
 * wrong jurisdiction or asks to start over (`pnpm -C apps/sdp-api mainnet-access`). It never
 * grants mainnet: that stays Clerk's `enableProductionProject`. Audited with the change, then
 * emailed to the operator address, because the request email sent earlier no longer describes the
 * request and must not be approved from.
 *
 * @throws When the change is saved but the operator email fails, saying so, so the operator can
 *   tell the alias by hand.
 */
export async function correctMainnetAccess(
  env: Env,
  input: MainnetAccessCorrection
): Promise<MainnetAccessCorrectionResult> {
  const { request, earlier } = await createSystemAuditService(env).logSystemWithin(async (db) => {
    const repository = new MainnetAccessRepository(db);
    const before = await repository.get(input.organizationId, { forUpdate: true });
    if (!before) throw new Error("This organization has not requested mainnet access");
    // A send that started first must land first, or its email would follow this correction's.
    if (await repository.sendInFlight(input.organizationId)) {
      throw new Error("The request email is being sent right now; run this again in a minute");
    }
    const context = await repository.emailContext(before);

    let after: MainnetAccessRow | null = null;
    const metadata: Record<string, unknown> = {
      event: "mainnet_access_corrected",
      operation: input.operation,
      // The whole request as it stood, so a reset keeps who accepted which terms, and when.
      before: {
        countryCode: before.country_code,
        termsVersion: before.terms_version,
        requestedAt: before.requested_at,
        requestedByUserId: before.requested_by_user_id,
        notifiedAt: before.notified_at,
      },
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
      result: { request: after, earlier: requestEmail(before, context) },
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

  if (!mainnetAccessEmailConfig(env)) return { request, operatorEmail: "not_configured" };
  try {
    await sendMainnetAccessCorrectionEmail(env, {
      request: earlier,
      correction:
        input.operation === "set-country"
          ? {
              operation: "set-country",
              countryCode: input.countryCode,
              countryName: countryByCode(input.countryCode).name,
            }
          : { operation: "reset" },
      operator: input.operator,
      reason: input.reason,
      ticket: input.ticket,
    });
  } catch (error) {
    throw new Error(
      `The ${input.operation} is saved, but emailing the operator address failed; tell it by hand.`,
      { cause: error }
    );
  }
  return { request, operatorEmail: "sent" };
}
