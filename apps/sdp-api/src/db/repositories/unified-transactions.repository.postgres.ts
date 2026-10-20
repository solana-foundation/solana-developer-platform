import {
  UNIFIED_TRANSACTION_MODULES,
  type UnifiedTransactionModule,
} from "@sdp/types/unified-transactions";
import { tokenFilterAliases } from "@sdp/types/well-known-tokens";
import { z } from "zod";
import { buildInClause, escapeLikePattern } from "@/db/postgres-utils";
import { badRequest } from "@/lib/errors";
import { decodeKeysetCursor, encodeKeysetCursor } from "@/lib/keyset-cursor";
import { unifiedTransactionSchema } from "@/routes/transactions/schemas";
import type {
  ListUnifiedTransactionsInput,
  UnifiedTransactionsRepository,
  UnifiedTransactionsRepositoryDb,
} from "./unified-transactions.repository";

const UNIFIED_TRANSACTION_COLUMNS = `id, module, kind, module_id AS "moduleId", module_status AS "moduleStatus",
  status AS "status", organization_id AS "organizationId", project_id AS "projectId",
  custody_wallet_id AS "custodyWalletId", custody_wallet_label AS "custodyWalletLabel", token, amount, counterparty_id AS "counterpartyId", signature,
  created_at AS "createdAt"`;

const cursorValueSchema = z.object({
  createdAt: z.string(),
  module: z.enum(UNIFIED_TRANSACTION_MODULES),
});

function parseCursor(cursor: string): {
  createdAt: string;
  module: UnifiedTransactionModule;
  id: string;
} {
  const envelope = decodeKeysetCursor(cursor);
  const value =
    envelope === null ? null : cursorValueSchema.safeParse(readJsonOrNull(envelope.value));
  if (envelope === null || value === null || !value.success) {
    throw badRequest("Invalid transaction cursor");
  }
  return { ...value.data, id: envelope.id };
}

function readJsonOrNull(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * The rows the caller may see: its permitted modules, the Payments kinds it
 * may read, and no ramp transfer of a provider the release channel leaves out.
 */
function permittedRowClauses(input: ListUnifiedTransactionsInput): {
  clauses: string[];
  values: unknown[];
} {
  const clauses = [`module IN (${buildInClause(input.modules.length)})`];
  const values: unknown[] = [...input.modules];
  if (input.modules.includes("payments")) {
    clauses.push(`(module <> 'payments' OR kind IN (${buildInClause(input.paymentKinds.length)}))`);
    values.push(...input.paymentKinds);
  }
  if (input.excludedRampProviders.length > 0) {
    clauses.push(
      `NOT (module = 'payments' AND EXISTS (SELECT 1 FROM payment_transfers pt WHERE pt.id = unified_transactions.module_id AND pt.provider IN (${buildInClause(input.excludedRampProviders.length)})))`
    );
    values.push(...input.excludedRampProviders);
  }
  return { clauses, values };
}

export function createPostgresUnifiedTransactionsRepository(
  db: UnifiedTransactionsRepositoryDb
): UnifiedTransactionsRepository {
  return {
    async list(input) {
      const clauses = ["organization_id = ?"];
      const values: unknown[] = [input.organizationId];
      const permitted = permittedRowClauses(input);
      clauses.push(...permitted.clauses);
      values.push(...permitted.values);
      if (input.projectId !== null) {
        clauses.push("project_id IS NOT DISTINCT FROM ?");
        values.push(input.projectId);
      }
      const equalFilters = [
        ["module", input.module],
        ["kind", input.kind],
        ["status", input.status],
        ["custody_wallet_id", input.custodyWalletId],
        ["counterparty_id", input.counterpartyId],
      ] as const;
      for (const [column, value] of equalFilters) {
        if (value !== undefined) {
          clauses.push(`${column} = ?`);
          values.push(value);
        }
      }
      if (input.token !== undefined) {
        const aliases = tokenFilterAliases(input.token);
        clauses.push(`token IN (${buildInClause(aliases.length)})`);
        values.push(...aliases);
      }
      if (input.search !== undefined) {
        // Prefix match, not contains: every searchable column is an
        // identifier pasted from its start. This is still a scan — the
        // underlying tables carry no ILIKE-compatible indexes on these
        // columns — but a prefix comparison rejects rows on the first bytes
        // instead of substring-searching every value, and it removes the
        // guaranteed worst case a leading wildcard forces. The metered quota
        // on the route is what actually bounds the spend.
        const pattern = `${escapeLikePattern(input.search)}%`;
        clauses.push(
          "(id ILIKE ? ESCAPE '\\' OR module_id ILIKE ? ESCAPE '\\' OR signature ILIKE ? ESCAPE '\\')"
        );
        values.push(pattern, pattern, pattern);
      }
      if (input.createdAtFrom !== undefined) {
        clauses.push("created_at >= ?");
        values.push(input.createdAtFrom);
      }
      if (input.createdAtTo !== undefined) {
        clauses.push("created_at <= ?");
        values.push(input.createdAtTo);
      }
      if (input.cursor !== undefined) {
        const cursor = parseCursor(input.cursor);
        clauses.push("(created_at, module, id) < (?, ?, ?)");
        values.push(cursor.createdAt, cursor.module, cursor.id);
      }
      const result = await db.queryMany(
        `SELECT ${UNIFIED_TRANSACTION_COLUMNS} FROM unified_transactions WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC, module DESC, id DESC LIMIT ?`,
        [...values, input.limit + 1]
      );
      const rows = result.map((row) => unifiedTransactionSchema.parse(row));
      if (rows.length <= input.limit) {
        return { rows, nextCursor: null };
      }
      const page = rows.slice(0, input.limit);
      const last = page[input.limit - 1];
      return {
        rows: page,
        nextCursor: encodeKeysetCursor(
          JSON.stringify({ createdAt: last.createdAt, module: last.module }),
          last.id
        ),
      };
    },
  };
}
