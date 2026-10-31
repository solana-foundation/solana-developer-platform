/**
 * An organization's mainnet access request (HOO-2427), stored on the organization's row (migration 0201):
 * the declared jurisdiction, the Terms and Conditions version accepted with it, and the request.
 * The migration's check keeps them whole, so a request exists exactly when `mainnet_requested_at`
 * is set.
 */
import { type CountryCode, isCountryCode } from "@sdp/types/countries";
import type { DatabaseExecutor } from "@/db/client";
import { internalError } from "@/lib/errors";

export interface MainnetAccessRow {
  organization_id: string;
  country_code: CountryCode;
  terms_version: string;
  requested_at: string;
  requested_by_user_id: string;
  notified_at: string | null;
}

export interface MainnetAccessClaim {
  organizationId: string;
  userId: string;
  countryCode: CountryCode;
  termsVersion: string;
}

/** A held send of the request email: the request as claimed, and the claim's own timestamp. */
export interface MainnetAccessSendClaim {
  row: MainnetAccessRow;
  claimedAt: string;
}

export interface MainnetAccessEmailContext {
  organization_name: string;
  requester_email: string | null;
  requester_name: string | null;
}

/** The organization's columns under the names the rest of mainnet access reads. */
const COLUMNS = `id AS organization_id, jurisdiction_country_code AS country_code,
  terms_accepted_version AS terms_version,
  mainnet_requested_at AS requested_at, mainnet_requested_by_user_id AS requested_by_user_id,
  mainnet_request_notified_at AS notified_at`;

/**
 * How long a send claim holds. The send gives up after 10 seconds, so only a process that died
 * mid-send leaves a claim this old.
 */
const SEND_CLAIM_LEASE = "interval '2 minutes'";
const SEND_CLAIM_LIVE = `mainnet_request_sending_at IS NOT NULL
  AND mainnet_request_sending_at::timestamptz > now() - ${SEND_CLAIM_LEASE}`;

type StoredColumns = {
  [Column in keyof MainnetAccessRow]: string | null;
} & { organization_id: string };

/** The organization's request, or null when it has not asked. */
function requestOf(columns: StoredColumns): MainnetAccessRow | null {
  const { requested_at, requested_by_user_id, country_code, terms_version } = columns;
  if (requested_at === null) return null;
  if (requested_by_user_id === null || country_code === null || terms_version === null) {
    throw internalError("Mainnet access request is stored incomplete");
  }
  if (!isCountryCode(country_code)) {
    throw internalError("Mainnet access request names an unknown country");
  }
  return {
    organization_id: columns.organization_id,
    country_code,
    terms_version,
    requested_at,
    requested_by_user_id,
    notified_at: columns.notified_at,
  };
}

/** SQL for one organization's mainnet access; callers keep the surrounding transaction. */
export class MainnetAccessRepository {
  constructor(private readonly db: DatabaseExecutor) {}

  /** @returns The request, or null when the organization exists and has not asked. */
  async get(organizationId: string, options: { forUpdate?: boolean } = {}) {
    const columns = await this.db.queryOne<StoredColumns>(
      `SELECT ${COLUMNS} FROM organizations WHERE id = ?${options.forUpdate ? " FOR UPDATE" : ""}`,
      [organizationId]
    );
    if (!columns) throw internalError("Organization not found for mainnet access");
    return requestOf(columns);
  }

  /**
   * Records the request when the organization has none. One statement claims it, so two admins
   * submitting at once record one of them.
   *
   * @returns The new request, or null when one already exists.
   */
  async claim(claim: MainnetAccessClaim): Promise<MainnetAccessRow | null> {
    const columns = await this.db.queryOne<StoredColumns>(
      `UPDATE organizations
       SET jurisdiction_country_code = ?, terms_accepted_version = ?,
           mainnet_requested_at = sdp_iso_now(), mainnet_requested_by_user_id = ?,
           updated_at = sdp_datetime_now()
       WHERE id = ? AND mainnet_requested_at IS NULL
       RETURNING ${COLUMNS}`,
      [claim.countryCode, claim.termsVersion, claim.userId, claim.organizationId]
    );
    return columns ? requestOf(columns) : null;
  }

  /** @returns The organization's name and the requester's, for the email to the alias. */
  async emailContext(row: MainnetAccessRow): Promise<MainnetAccessEmailContext> {
    const context = await this.db.queryOne<MainnetAccessEmailContext>(
      `SELECT o.name AS organization_name, u.email AS requester_email, u.name AS requester_name
       FROM organizations o
       LEFT JOIN users u ON u.id = ?
       WHERE o.id = ?`,
      [row.requested_by_user_id, row.organization_id]
    );
    if (!context) throw internalError("Organization not found for mainnet access");
    return context;
  }

  /**
   * Claims the one send of an unsent request, so a second send and a correction wait for it. The
   * claim commits before the email goes out, and the email describes the row it returns.
   *
   * @returns The claim, or null when there is no unsent request or another send holds it.
   */
  async claimSend(organizationId: string): Promise<MainnetAccessSendClaim | null> {
    const columns = await this.db.queryOne<StoredColumns & { claimed_at: string }>(
      `UPDATE organizations
       SET mainnet_request_sending_at = sdp_iso_now()
       WHERE id = ? AND mainnet_requested_at IS NOT NULL AND mainnet_request_notified_at IS NULL
         AND NOT (${SEND_CLAIM_LIVE})
       RETURNING ${COLUMNS}, mainnet_request_sending_at AS claimed_at`,
      [organizationId]
    );
    if (!columns) return null;
    const row = requestOf(columns);
    if (!row) throw internalError("Mainnet access send claimed without a request");
    return { row, claimedAt: columns.claimed_at };
  }

  /**
   * Marks the claimed request sent and lets go of the claim.
   *
   * @returns The sent request, or null when the claim lapsed and something else changed it.
   */
  async markNotified(claim: MainnetAccessSendClaim): Promise<MainnetAccessRow | null> {
    const columns = await this.db.queryOne<StoredColumns>(
      `UPDATE organizations
       SET mainnet_request_notified_at = sdp_iso_now(), mainnet_request_sending_at = NULL
       WHERE id = ? AND mainnet_request_sending_at = ?
       RETURNING ${COLUMNS}`,
      [claim.row.organization_id, claim.claimedAt]
    );
    return columns ? requestOf(columns) : null;
  }

  /** Lets go of a claim whose send failed, so the request can be sent again. */
  async releaseSend(claim: MainnetAccessSendClaim): Promise<void> {
    await this.db.execute(
      `UPDATE organizations SET mainnet_request_sending_at = NULL
       WHERE id = ? AND mainnet_request_sending_at = ?`,
      [claim.row.organization_id, claim.claimedAt]
    );
  }

  /** Whether a send of the request email holds its claim now; read under the row's lock. */
  async sendInFlight(organizationId: string): Promise<boolean> {
    const result = await this.db.queryOne<{ in_flight: boolean }>(
      `SELECT ${SEND_CLAIM_LIVE} AS in_flight FROM organizations WHERE id = ?`,
      [organizationId]
    );
    return result?.in_flight === true;
  }

  async setCountry(organizationId: string, countryCode: CountryCode): Promise<MainnetAccessRow> {
    const columns = await this.db.queryOne<StoredColumns>(
      `UPDATE organizations
       SET jurisdiction_country_code = ?, updated_at = sdp_datetime_now()
       WHERE id = ?
       RETURNING ${COLUMNS}`,
      [countryCode, organizationId]
    );
    const row = columns ? requestOf(columns) : null;
    if (!row) throw internalError("Mainnet access request not found to correct");
    return row;
  }

  async reset(organizationId: string): Promise<void> {
    await this.db.execute(
      `UPDATE organizations
       SET jurisdiction_country_code = NULL, terms_accepted_version = NULL,
           mainnet_requested_at = NULL, mainnet_requested_by_user_id = NULL,
           mainnet_request_notified_at = NULL, mainnet_request_sending_at = NULL,
           updated_at = sdp_datetime_now()
       WHERE id = ?`,
      [organizationId]
    );
  }
}
