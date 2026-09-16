import {
  tokenFilterAliases,
  UNIFIED_TRANSACTION_MODULES,
  type UnifiedTransactionModule,
} from "@sdp/types";
import { z } from "zod";
import { buildInClause, escapeLikePattern } from "@/db/postgres-utils";
import { badRequest } from "@/lib/errors";
import { decodeKeysetCursor, encodeKeysetCursor } from "@/lib/keyset-cursor";
import { unifiedTransactionSchema } from "@/routes/transactions/schemas";
import type {
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

export function createPostgresUnifiedTransactionsRepository(
  db: UnifiedTransactionsRepositoryDb
): UnifiedTransactionsRepository {
  return {
    async list(input) {
      const clauses = ["organization_id = ?"];
      const values: unknown[] = [input.organizationId];
      clauses.push(`module IN (${buildInClause(input.modules.length)})`);
      values.push(...input.modules);
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
        // identifier pasted from its start, and a leading wildcard forces a
        // sequential scan of every module's money table behind the view.
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
      if (input.moduleWalletScopes !== undefined) {
        const scoped = input.moduleWalletScopes.filter(
          (scope) => scope.custodyWalletIds.length > 0
        );
        if (scoped.length === 0) {
          clauses.push("FALSE");
        } else {
          clauses.push(
            `(${scoped
              .map(
                (scope) =>
                  `(module = ? AND custody_wallet_id IN (${buildInClause(scope.custodyWalletIds.length)}))`
              )
              .join(" OR ")})`
          );
          for (const scope of scoped) {
            values.push(scope.module, ...scope.custodyWalletIds);
          }
        }
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
