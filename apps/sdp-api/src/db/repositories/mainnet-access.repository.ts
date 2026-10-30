/**
 * An organization's mainnet access request (HOO-2427), stored on its own row (migration 0192):
 * the declared jurisdiction, the Terms and Conditions acceptance and the request. The migration's
 * checks keep each group whole, so a request exists exactly when `mainnet_requested_at` is set.
 */
import { COUNTRY_CODES, type CountryCode } from "@sdp/types/countries";
import type { DatabaseExecutor } from "@/db/client";
import { internalError } from "@/lib/errors";

export interface MainnetAccessRow {
  organization_id: string;
  country_code: CountryCode;
  terms_version: string;
  terms_accepted_at: string;
  terms_accepted_by_user_id: string;
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

export interface MainnetAccessEmailContext {
  organization_name: string;
  requester_email: string | null;
  requester_name: string | null;
}

/** The organization's columns under the names the rest of mainnet access reads. */
const COLUMNS = `id AS organization_id, jurisdiction_country_code AS country_code,
  terms_accepted_version AS terms_version, terms_accepted_at, terms_accepted_by_user_id,
  mainnet_requested_at AS requested_at, mainnet_requested_by_user_id AS requested_by_user_id,
  mainnet_request_notified_at AS notified_at`;

type StoredColumns = {
  [Column in keyof MainnetAccessRow]: string | null;
} & { organization_id: string };

function isCountryCode(code: string): code is CountryCode {
  return COUNTRY_CODES.some((candidate) => candidate === code);
}

/** The organization's request, or null when it has not asked. */
function requestOf(columns: StoredColumns): MainnetAccessRow | null {
  const {
    requested_at,
    requested_by_user_id,
    country_code,
    terms_version,
    terms_accepted_at,
    terms_accepted_by_user_id,
  } = columns;
  if (requested_at === null) return null;
  if (
    requested_by_user_id === null ||
    country_code === null ||
    terms_version === null ||
    terms_accepted_at === null ||
    terms_accepted_by_user_id === null
  ) {
    throw internalError("Mainnet access request is stored incomplete");
  }
  if (!isCountryCode(country_code)) {
    throw internalError("Mainnet access request names an unknown country");
  }
  return {
    organization_id: columns.organization_id,
    country_code,
    terms_version,
    terms_accepted_at,
    terms_accepted_by_user_id,
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
           terms_accepted_at = sdp_iso_now(), terms_accepted_by_user_id = ?,
           mainnet_requested_at = sdp_iso_now(), mainnet_requested_by_user_id = ?,
           updated_at = sdp_datetime_now()
       WHERE id = ? AND mainnet_requested_at IS NULL
       RETURNING ${COLUMNS}`,
      [claim.countryCode, claim.termsVersion, claim.userId, claim.userId, claim.organizationId]
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
   * Marks the request sent, if it is still the one that was emailed.
   *
   * @returns The sent request, or null when it was reset or replaced meanwhile.
   */
  async markNotified(row: MainnetAccessRow): Promise<MainnetAccessRow | null> {
    const columns = await this.db.queryOne<StoredColumns>(
      `UPDATE organizations
       SET mainnet_request_notified_at = COALESCE(mainnet_request_notified_at, sdp_iso_now())
       WHERE id = ? AND mainnet_requested_at = ?
       RETURNING ${COLUMNS}`,
      [row.organization_id, row.requested_at]
    );
    return columns ? requestOf(columns) : null;
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
           terms_accepted_at = NULL, terms_accepted_by_user_id = NULL,
           mainnet_requested_at = NULL, mainnet_requested_by_user_id = NULL,
           mainnet_request_notified_at = NULL, updated_at = sdp_datetime_now()
       WHERE id = ?`,
      [organizationId]
    );
  }
}
