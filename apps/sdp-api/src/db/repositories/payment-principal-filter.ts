import { internalError } from "@/lib/errors";

/**
 * Who set a payment up, as the list filters and a member's linked-payments read name them: an
 * API key, which also matches every key it was rotated from (rotation mints a new row for the
 * same credential), or a member acting in the dashboard, which never matches what their keys did.
 */
export type PaymentPrincipalFilter =
  | { kind: "api_key"; apiKeyId: string }
  | { kind: "member"; userId: string };

/**
 * The SQL predicate one principal filter applies to a payment table, so a list and a count that
 * name the same principal select the same rows.
 *
 * @param filter - The principal, or null for no filter.
 * @param params - Where the table records the principal.
 * @param params.organizationId - The Organization the key lineage is read in.
 * @param params.apiKeyColumn - The column naming the API key that acted, null for a member.
 * @param params.userColumn - The column naming the member that acted.
 * @returns The predicate and its binds.
 */
export function paymentPrincipalPredicate(
  filter: PaymentPrincipalFilter | null,
  params: { organizationId: string; apiKeyColumn: string; userColumn: string }
): { sql: string; binds: string[] } {
  if (filter === null) {
    return { sql: "TRUE", binds: [] };
  }
  switch (filter.kind) {
    case "api_key":
      return {
        sql: `${params.apiKeyColumn} IN (
          WITH RECURSIVE lineage(id, rotated_from) AS (
            SELECT id, rotated_from FROM api_keys WHERE id = ? AND organization_id = ?
            UNION
            SELECT ak.id, ak.rotated_from
              FROM api_keys ak
              JOIN lineage ON ak.id = lineage.rotated_from
             WHERE ak.organization_id = ?
          )
          SELECT id FROM lineage
        )`,
        binds: [filter.apiKeyId, params.organizationId, params.organizationId],
      };
    case "member":
      return {
        sql: `${params.userColumn} = ? AND ${params.apiKeyColumn} IS NULL`,
        binds: [filter.userId],
      };
    default: {
      const unreachable: never = filter;
      throw internalError(`Unhandled payment principal filter ${String(unreachable)}`);
    }
  }
}
