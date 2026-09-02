import type {
  EarnApyType,
  EarnLiquidityTerm,
  EarnStrategyRiskMetadata,
  EarnStrategySourceKind,
  EarnStrategyStatus,
  SdpEnvironment,
  SolanaCluster,
} from "@sdp/types";
import { CLUSTER_BY_SDP_ENVIRONMENT } from "@sdp/types";
import { type AppDb, asTransactionalClient } from "@/db";
import type {
  DeleteUnlistedEarnStrategiesInput,
  EarnProviderWalletRow,
  EarnRepository,
  EarnStrategyRow,
  InsertEarnProviderWalletInput,
  ListEarnProviderWalletsInput,
  ListEarnProviderWalletsResult,
  ListEarnStrategiesInput,
  ListEarnStrategiesResult,
  UpdateEarnStrategyMetricsInput,
  UpsertEarnStrategyInput,
} from "./earn.repository";
import { generateEarnProviderWalletId, generateEarnStrategyId } from "./earn.repository";
import { mintEarnPositionForProviderWallet } from "./earn-movements.repository";

/**
 * `host_cluster` is NULLABLE in the schema on purpose (migration 0057 is the
 * expand half of an expand/contract rollout), so the read has to answer for a
 * row an older writer left unset. It answers with the environment's own
 * cluster — the same rule the migration's backfill applies, and true of every
 * writer that predates the column: Ground's catalogue gate only ever admits a
 * source hosted on the environment's own chain.
 *
 * Failing closed here instead would be worse than useless: a NULL row would
 * come back un-fundable, so a mid-deploy or rolled-back write would quietly
 * drop live Ground strategies out of the wizard. Reading the fact that IS
 * known keeps such a row correct until the next sync states it explicitly.
 */
function mapStrategyRow(row: Record<string, unknown>): EarnStrategyRow {
  const environment = row.environment as SdpEnvironment;
  return {
    id: row.id as string,
    provider: row.provider as string,
    provider_reference: row.provider_reference as string,
    name: row.name as string,
    source_kind: row.source_kind as EarnStrategySourceKind,
    underlying_source: row.underlying_source as string | null,
    deposit_mints: row.deposit_mints as string[],
    share_mint: row.share_mint as string | null,
    apy_type: row.apy_type as EarnApyType,
    current_apy: row.current_apy as string | null,
    liquidity_term: row.liquidity_term as EarnLiquidityTerm,
    redemption_delay_days: row.redemption_delay_days as number | null,
    risk_metadata: row.risk_metadata as EarnStrategyRiskMetadata,
    status: row.status as EarnStrategyStatus,
    host_cluster:
      (row.host_cluster as SolanaCluster | null) ?? CLUSTER_BY_SDP_ENVIRONMENT[environment],
    environment,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function mapProviderWalletRow(row: Record<string, unknown>): EarnProviderWalletRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    project_id: row.project_id as string | null,
    environment: row.environment as SdpEnvironment,
    provider: row.provider as string,
    provider_wallet_ref: row.provider_wallet_ref as string,
    label: row.label as string | null,
    created_by: row.created_by as string,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

/**
 * Shared count+page read for the earn list methods (same shape as the
 * payments-family where-builder idiom).
 *
 * `ordering` is a literal ORDER BY body (never caller input) and every value
 * passed must be TOTAL: end it with an `id` tiebreaker, because bulk catalogue
 * syncs write many rows in the same sdp_iso_now() instant and any prefix of the
 * sort can tie — a non-total order makes OFFSET pages repeat and skip rows.
 *
 * REQUIRED rather than defaulted, so a new list states its own order instead of
 * inheriting one silently: the two existing callers want genuinely different
 * orders (strategies rank by TVL, programs oldest-first so the head of that
 * list cannot move when a program is created — migration 0056's header explains
 * what breaks if it does), which is exactly the situation where an invisible
 * default is the wrong answer. `NEWEST_FIRST` stays as the shared tail every
 * total ordering can end with.
 */
const NEWEST_FIRST = "created_at DESC, id DESC";

async function selectPage<Row>(
  db: AppDb,
  table: "earn_strategies" | "earn_provider_wallets",
  conditions: string[],
  bindings: unknown[],
  window: { limit: number; offset: number },
  mapRow: (row: Record<string, unknown>) => Row,
  ordering: string
): Promise<{ rows: Row[]; total: number }> {
  const where = conditions.join(" AND ");

  const [page, countRow] = await Promise.all([
    db
      .prepare(
        `SELECT * FROM ${table}
           WHERE ${where}
           ORDER BY ${ordering}
           LIMIT ? OFFSET ?`
      )
      .bind(...bindings, window.limit, window.offset)
      .all<Record<string, unknown>>(),
    db
      .prepare(`SELECT COUNT(*)::int AS total FROM ${table} WHERE ${where}`)
      .bind(...bindings)
      .first<{ total: number }>(),
  ]);

  return {
    rows: (page.results ?? []).map(mapRow),
    total: countRow?.total ?? 0,
  };
}

export function createPostgresEarnRepository(db: AppDb): EarnRepository {
  return {
    async upsertStrategy(input: UpsertEarnStrategyInput) {
      const id = generateEarnStrategyId();

      const row = await db
        .prepare(
          `INSERT INTO earn_strategies (
             id, provider, provider_reference, name,
             source_kind, underlying_source, deposit_mints, share_mint,
             apy_type, current_apy, liquidity_term, redemption_delay_days,
             risk_metadata, status, host_cluster, environment
           ) VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?)
           ON CONFLICT (provider, provider_reference, environment) DO UPDATE SET
             name = EXCLUDED.name,
             source_kind = EXCLUDED.source_kind,
             underlying_source = EXCLUDED.underlying_source,
             deposit_mints = EXCLUDED.deposit_mints,
             share_mint = EXCLUDED.share_mint,
             apy_type = EXCLUDED.apy_type,
             current_apy = EXCLUDED.current_apy,
             liquidity_term = EXCLUDED.liquidity_term,
             redemption_delay_days = EXCLUDED.redemption_delay_days,
             risk_metadata = EXCLUDED.risk_metadata,
             host_cluster = EXCLUDED.host_cluster,
             -- An operator pause/deprecation outranks the provider catalogue.
             -- The hourly sync always upserts 'active' for anything a provider
             -- still lists, so overwriting status here would silently unpause a
             -- strategy stopped for an exploit or depeg within the hour and let
             -- deposits resume. Reactivation is therefore deliberate: metadata
             -- and rates keep flowing, but leaving paused/deprecated takes an
             -- explicit status write, never a sync.
             status = CASE
               WHEN earn_strategies.status IN ('paused', 'deprecated')
                 THEN earn_strategies.status
               ELSE EXCLUDED.status
             END,
             updated_at = sdp_iso_now()
           RETURNING *`
        )
        .bind(
          id,
          input.provider,
          input.providerReference,
          input.name,
          input.sourceKind,
          input.underlyingSource,
          JSON.stringify(input.depositMints),
          input.shareMint,
          input.apyType,
          input.currentApy,
          input.liquidityTerm,
          input.redemptionDelayDays,
          JSON.stringify(input.riskMetadata ?? {}),
          input.status,
          input.hostCluster,
          input.environment
        )
        .first<Record<string, unknown>>();

      return row ? mapStrategyRow(row) : null;
    },

    async updateStrategyMetrics(input: UpdateEarnStrategyMetricsInput) {
      // `||` merges the incoming keys over the stored object, so a refresh that
      // reports only tvlUsd and holders leaves curator (which the hourly sync
      // derives) exactly as it was. A plain assignment here would silently
      // strip every field the refresh does not carry.
      //
      // No status predicate: refreshing an operator-PAUSED row's rate is
      // correct — the pause stops deposits, it does not freeze the vault's
      // real-world numbers, and an operator deciding whether to unpause wants
      // the current figures, not the ones from the moment they stopped it.
      const row = await db
        .prepare(
          `UPDATE earn_strategies
              SET current_apy = ?,
                  risk_metadata = risk_metadata || ?::jsonb,
                  updated_at = sdp_iso_now()
            WHERE provider = ? AND provider_reference = ? AND environment = ?
            RETURNING id`
        )
        .bind(
          input.currentApy,
          JSON.stringify(input.riskMetadata ?? {}),
          input.provider,
          input.providerReference,
          input.environment
        )
        .first<Record<string, unknown>>();
      return row !== null && row !== undefined;
    },

    async getStrategyById(strategyId: string) {
      const row = await db
        .prepare(`SELECT * FROM earn_strategies WHERE id = ?`)
        .bind(strategyId)
        .first<Record<string, unknown>>();
      return row ? mapStrategyRow(row) : null;
    },

    async deleteUnlistedStrategies(input: DeleteUnlistedEarnStrategiesInput) {
      // Only `active` rows are deleted. An operator `paused`/`deprecated` is a
      // deliberate human record, and it is load-bearing: upsertStrategy refuses
      // to overwrite it precisely so a vault stopped for an exploit or depeg
      // cannot be silently reactivated by a sync. Deleting such a row would
      // discard that guard — the next time the provider listed the reference, it
      // would be inserted fresh as `active`. So an operator-stopped row is the
      // one thing this pass leaves behind; it is invisible to every read anyway
      // (the catalogue and program-creation paths both filter `status = 'active'`).
      //
      // An empty keep set would match EVERY active row (`= ANY('{}')` is false,
      // so `NOT` admits everything) and delete the provider's whole shelf.
      // "The provider listed nothing" is indistinguishable from a misconfigured
      // account or a silently-empty response, so it can never trigger a
      // catalogue-wide teardown, unless the caller explicitly authorizes it
      // (`allowEmptyKeepSet`), which the mirror lane does when its truth source
      // reliably answered "nothing is listed". Even then the delist must be
      // cluster-scoped: an authorized empty pass tears down one sub-shelf, never
      // an environment.
      if (input.listedProviderReferences.length === 0 && !input.allowEmptyKeepSet) {
        return [];
      }
      if (input.allowEmptyKeepSet && !input.hostCluster) {
        throw new Error("deleteUnlistedStrategies: allowEmptyKeepSet requires a cluster scope");
      }

      const conditions = ["provider = ?", "environment = ?", "status = 'active'"];
      const bindings: unknown[] = [input.provider, input.environment];
      if (input.hostCluster) {
        // COALESCE mirrors mapStrategyRow's NULL rule: a row an older writer left
        // unset means the environment's own cluster, so a delist scoped to that
        // cluster governs it and a mainnet-scoped delist leaves it alone.
        conditions.push("COALESCE(host_cluster, ?) = ?");
        bindings.push(CLUSTER_BY_SDP_ENVIRONMENT[input.environment], input.hostCluster);
      }
      if (input.listedProviderReferences.length > 0) {
        conditions.push("NOT (provider_reference = ANY(?))");
        bindings.push([...input.listedProviderReferences]);
      }

      const rows = await db
        .prepare(
          `DELETE FROM earn_strategies
            WHERE ${conditions.join("\n              AND ")}
            RETURNING provider_reference`
        )
        .bind(...bindings)
        .all<{ provider_reference: string }>();

      return (rows.results ?? []).map((row) => row.provider_reference);
    },

    async listStrategies(input: ListEarnStrategiesInput): Promise<ListEarnStrategiesResult> {
      const conditions = ["environment = ?"];
      const bindings: unknown[] = [input.environment];

      if (!input.includeInactive) {
        conditions.push("status = 'active'");
      }
      if (input.hostCluster) {
        // COALESCE mirrors mapStrategyRow's NULL rule (a pre-0057 row means the
        // environment's own cluster), so the default devnet view cannot drop a
        // legacy row the read layer would report as devnet.
        conditions.push("COALESCE(host_cluster, ?) = ?");
        bindings.push(CLUSTER_BY_SDP_ENVIRONMENT[input.environment], input.hostCluster);
      }
      if (input.sourceKind) {
        conditions.push("source_kind = ?");
        bindings.push(input.sourceKind);
      }
      if (input.apyType) {
        conditions.push("apy_type = ?");
        bindings.push(input.apyType);
      }
      if (input.liquidityTerm) {
        conditions.push("liquidity_term = ?");
        bindings.push(input.liquidityTerm);
      }
      if (input.providers !== undefined) {
        if (input.providers.length === 0) {
          // `provider IN ()` is a syntax error, and falling through to "no
          // filter" would surface EVERY provider the moment the offered set went
          // empty — the exact inversion this filter exists to prevent.
          conditions.push("1 = 0");
        } else {
          conditions.push(`provider IN (${input.providers.map(() => "?").join(", ")})`);
          bindings.push(...input.providers);
        }
      }
      if (input.excludeProviderKeys?.length) {
        const placeholders = input.excludeProviderKeys.map(() => "?").join(", ");
        // Concatenated so one binding list covers both halves of the key; a bare
        // provider_reference match could hide another provider's vault that
        // happens to share a reference.
        conditions.push(`(provider || ':' || provider_reference) NOT IN (${placeholders})`);
        bindings.push(...input.excludeProviderKeys);
      }
      for (const [provider, references] of Object.entries(input.allowedProviderReferences ?? {})) {
        if (references.length === 0) {
          conditions.push("provider <> ?");
          bindings.push(provider);
          continue;
        }
        // Scoped to the one provider: every other provider's rows pass through,
        // so adding an allowlist for one shelf never silently curates another.
        const placeholders = references.map(() => "?").join(", ");
        conditions.push(`(provider <> ? OR provider_reference IN (${placeholders}))`);
        bindings.push(provider, ...references);
      }
      for (const rawTerm of input.excludeRelatedTerms ?? []) {
        const term = rawTerm.trim().toLowerCase();
        if (!term) continue;
        const pattern = `%${term}%`;
        conditions.push(
          `(LOWER(provider_reference) NOT LIKE ?
            AND LOWER(name) NOT LIKE ?
            AND LOWER(COALESCE(underlying_source, '')) NOT LIKE ?)`
        );
        bindings.push(pattern, pattern, pattern);
      }

      // The PRD ranks the shelf by deposit size (PRO-1732): TVL descending,
      // rows with no TVL last — devnet rows carry none by design (the metrics
      // endpoint is mainnet's), so the sandbox default view falls through to
      // newest-first. TVL lives in the `riskMetadata` JSON (`tvlUsd`); at a
      // ~25-row shelf per cluster the cast costs nothing, so it does not earn
      // its own column. The trailing (created_at, id) keeps the order TOTAL —
      // equal-TVL and no-TVL rows would otherwise make OFFSET pages repeat and
      // skip rows.
      //
      // The `jsonb_typeof` guard is load-bearing, not belt-and-braces: the
      // column is an open bag (`EarnStrategyRiskMetadata` allows any key, and
      // the schema only CHECKs that the whole value is an object), so "always a
      // JSON number or absent" is a convention two provider clients keep, NOT
      // something the database enforces. A bare `::numeric` cast would turn one
      // malformed row — a string `"12M"`, a bool — into a 500 on EVERY
      // `GET /strategies` for that environment, an outage far from the write
      // that caused it. Guarded, such a row reads as unsized and sorts last.
      return selectPage(
        db,
        "earn_strategies",
        conditions,
        bindings,
        input,
        mapStrategyRow,
        `CASE WHEN jsonb_typeof(risk_metadata->'tvlUsd') = 'number'
              THEN (risk_metadata->>'tvlUsd')::numeric END DESC NULLS LAST, ${NEWEST_FIRST}`
      );
    },

    async getProviderWalletById(params) {
      const row = await db
        .prepare(
          `SELECT * FROM earn_provider_wallets
             WHERE organization_id = ? AND environment = ? AND id = ?`
        )
        .bind(params.organizationId, params.environment, params.walletId)
        .first<Record<string, unknown>>();
      return row ? mapProviderWalletRow(row) : null;
    },

    async listProviderWallets(
      input: ListEarnProviderWalletsInput
    ): Promise<ListEarnProviderWalletsResult> {
      const conditions = ["organization_id = ?", "environment = ?"];
      const bindings: unknown[] = [input.organizationId, input.environment];

      if (input.provider) {
        conditions.push("provider = ?");
        bindings.push(input.provider);
      }

      // Oldest first, so the head of the list is stable for a program's
      // whole life (migration 0056).
      return selectPage(
        db,
        "earn_provider_wallets",
        conditions,
        bindings,
        input,
        mapProviderWalletRow,
        "created_at ASC, id ASC"
      );
    },

    async getProviderWalletByRef(params) {
      const row = await db
        .prepare(
          `SELECT * FROM earn_provider_wallets
             WHERE provider = ? AND provider_wallet_ref = ?`
        )
        .bind(params.provider, params.providerWalletRef)
        .first<Record<string, unknown>>();
      return row ? mapProviderWalletRow(row) : null;
    },

    async insertProviderWallet(input: InsertEarnProviderWalletInput) {
      const id = generateEarnProviderWalletId();

      // Linking a program also opens its custodial HOLDING in the unified
      // ledger, atomically. Without it the program's first withdrawal would have
      // no position to belong to, and the ledger requires every movement to have
      // one (PRO-1705). 0064 does the same for programs that already exist.
      return db.transaction(async (executor) => {
        const transaction = asTransactionalClient(executor);
        const row = await transaction
          .prepare(
            `INSERT INTO earn_provider_wallets (
             id, organization_id, project_id, environment,
             provider, provider_wallet_ref, label, created_by
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           RETURNING *`
          )
          .bind(
            id,
            input.organizationId,
            input.projectId,
            input.environment,
            input.provider,
            input.providerWalletRef,
            input.label,
            input.createdBy
          )
          .first<Record<string, unknown>>();
        if (!row) return null;

        await mintEarnPositionForProviderWallet(transaction, id);
        return mapProviderWalletRow(row);
      });
    },
  };
}
