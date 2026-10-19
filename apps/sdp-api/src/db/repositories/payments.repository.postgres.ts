import { SDP_ENVIRONMENTS } from "@sdp/types/api-keys";
import {
  type PaymentTransferStatus,
  RAMP_TRANSFER_TRANSITIONS,
  RAMP_TRANSFER_TYPES,
  type RampTransferType,
  WALLET_TRANSFER_TYPES,
} from "@sdp/types/payments";
import { PERSISTED_RAMP_PROVIDERS } from "@sdp/types/provider-access";
import type { PaymentTransactionKind } from "@sdp/types/unified-transactions";
import { tokenFilterAliases } from "@sdp/types/well-known-tokens";
import { z } from "zod";
import type { DatabaseExecutor } from "@/db/client";
import { buildInClause, escapeLikePattern } from "@/db/postgres-utils";
import { assertTenantClaim, type TenantScope, TenantScopeViolationError } from "@/lib/tenant-scope";
import { parseNullableCustodyWalletId } from "./payment-execution-identity";
import { PAYMENT_TRANSACTION_KIND_SQL } from "./payments.kind";
import type {
  CreatePaymentTransferInput,
  ListTransfersByStatusInput,
  ListTransfersInput,
  ListTransfersResult,
  PaymentsRepository,
  PaymentTransferRow,
  RampTransferTransitionInput,
  TransferStatusChangeFields,
  UpdatePaymentTransferInput,
} from "./payments.repository";

/** SQL a repository method adds to a guarded status change, each list bound in order. */
interface StatusChangeSql {
  /** Preconditions beyond the row's id, status and type. */
  clauses: readonly string[];
  clauseValues: readonly unknown[];
  /** Column writes beside the status and the fields. */
  assignments: readonly string[];
  assignmentValues: readonly unknown[];
}

const NO_STATUS_CHANGE_SQL: StatusChangeSql = {
  clauses: [],
  clauseValues: [],
  assignments: [],
  assignmentValues: [],
};

function paymentTransferSearchExpression(alias: string): string {
  return `(
    ${alias}.id || ' ' ||
    COALESCE(${alias}.signature, '') || ' ' ||
    COALESCE(${alias}.provider_reference, '') || ' ' ||
    COALESCE(${alias}.source_address, '') || ' ' ||
    COALESCE(${alias}.destination_address, '') || ' ' ||
    COALESCE(${alias}.memo, '') || ' ' ||
    COALESCE(${alias}.counterparty_id, '')
  )`;
}

function buildTransferListWhere(params: ListTransfersInput): {
  whereClause: string;
  values: unknown[];
} {
  const clauses = ["pt.organization_id = ?"];
  const values: unknown[] = [params.organizationId];
  const addEquals = (column: string, value: unknown) => {
    if (value === undefined) return;
    clauses.push(`${column} = ?`);
    values.push(value);
  };
  const addIn = (column: string, entries: readonly unknown[] | undefined) => {
    if (!entries?.length) return;
    clauses.push(`${column} IN (${buildInClause(entries.length)})`);
    values.push(...entries);
  };

  addEquals("pt.project_id", params.projectId ?? undefined);
  if (params.walletAuthorization) {
    const authorizationClauses: string[] = [];
    if (params.walletAuthorization.custodyWalletIds.length > 0) {
      authorizationClauses.push(
        `pt.custody_wallet_id IN (${buildInClause(params.walletAuthorization.custodyWalletIds.length)})`
      );
      values.push(...params.walletAuthorization.custodyWalletIds);
    }
    if (params.walletAuthorization.providerWalletIds.length > 0) {
      authorizationClauses.push(
        `(pt.custody_wallet_id IS NULL AND pt.wallet_id IN (${buildInClause(params.walletAuthorization.providerWalletIds.length)}))`
      );
      values.push(...params.walletAuthorization.providerWalletIds);
    }
    clauses.push(
      authorizationClauses.length > 0 ? `(${authorizationClauses.join(" OR ")})` : "1 = 0"
    );
  }
  addEquals("pt.custody_wallet_id", params.custodyWalletId);
  addEquals("pt.wallet_id", params.walletId);
  // walletIds is an authorization allowlist, not an optional filter: an empty
  // list means "authorized for no wallet" and must match nothing, while the
  // other addIn params legitimately treat an empty/absent list as no filter.
  if (params.walletIds !== undefined && params.walletIds.length === 0) {
    clauses.push("1 = 0");
  } else {
    addIn("pt.wallet_id", params.walletIds);
  }
  addEquals("pt.counterparty_id", params.counterpartyId);

  if (params.walletAddress) {
    clauses.push("(pt.source_address = ? OR pt.destination_address = ?)");
    values.push(params.walletAddress, params.walletAddress);
  }

  if (params.search) {
    const searchPattern = `%${escapeLikePattern(params.search)}%`;
    const transferScope = ["search_pt.organization_id = ?"];
    const counterpartyScope = ["search_c.organization_id = ?"];
    const transferScopeValues: unknown[] = [params.organizationId];
    const counterpartyScopeValues: unknown[] = [params.organizationId];

    if (params.projectId) {
      transferScope.push("search_pt.project_id = ?");
      counterpartyScope.push("search_c.project_id = ?");
      transferScopeValues.push(params.projectId);
      counterpartyScopeValues.push(params.projectId);
    }

    clauses.push(
      `pt.id IN (
         SELECT search_pt.id
         FROM payment_transfers search_pt
         WHERE ${transferScope.join(" AND ")}
           AND ${paymentTransferSearchExpression("search_pt")} ILIKE ? ESCAPE '\\'
         UNION
         SELECT named_pt.id
         FROM counterparties search_c
         JOIN payment_transfers named_pt
           ON named_pt.counterparty_id = search_c.id
          AND named_pt.organization_id = search_c.organization_id
          AND named_pt.project_id = search_c.project_id
         WHERE ${counterpartyScope.join(" AND ")}
           AND search_c.display_name ILIKE ? ESCAPE '\\'
       )`
    );
    values.push(...transferScopeValues, searchPattern, ...counterpartyScopeValues, searchPattern);
  }

  // `pt.token` is not written consistently — the same asset appears as a mint on
  // some rows and as a bare symbol on others, including within one transfer type.
  // Matching a single form silently dropped every row written the other way, so a
  // filter for SOL missed its mint rows and vice versa.
  //
  // A blank token is treated as no filter at all. The query schema takes `token`
  // as a bare optional string with no trim, so a whitespace-only value arrives
  // truthy; matching it literally is what the previous exact-match did, and it
  // returned zero rows for what is really an absent filter. Trimming here makes
  // that deliberate instead of a side effect of the alias list coming back empty.
  const tokenFilter = params.token?.trim();
  addIn("pt.token", tokenFilter ? tokenFilterAliases(tokenFilter) : undefined);
  addEquals("pt.direction", params.direction);
  addIn("pt.status", params.statuses);
  addIn("pt.type", params.types);
  addEquals("pt.provider", params.provider);
  addEquals("pt.provider_reference", params.providerReference);

  if (params.createdAtFrom) {
    clauses.push("pt.created_at >= ?");
    values.push(params.createdAtFrom);
  }
  if (params.createdAtTo) {
    clauses.push("pt.created_at <= ?");
    values.push(params.createdAtTo);
  }

  return { whereClause: clauses.join(" AND "), values };
}

export type PaymentTransferProjectionRow = Record<string, unknown> & {
  kind: PaymentTransactionKind;
};

// A retired provider's id still parses; an id this deployment does not know throws.
const storedTransferProviderSchema = z.enum(PERSISTED_RAMP_PROVIDERS).nullable();

/** Maps a raw `payment_transfers` projection row into the shared row shape; `kind` must ride the SELECT. */
export function mapTransferRow(row: PaymentTransferProjectionRow): PaymentTransferRow {
  return {
    id: row.id as string,
    organization_id: row.organization_id as string,
    project_id: row.project_id as string,
    custody_wallet_id: parseNullableCustodyWalletId(row.custody_wallet_id),
    wallet_id: row.wallet_id as string,
    counterparty_id: row.counterparty_id as string | null,
    counterparty_display_name: row.counterparty_display_name as string | null | undefined,
    source_address: row.source_address as string | null,
    destination_address: row.destination_address as string | null,
    token: row.token as string,
    amount: row.amount as string | null,
    memo: (row.memo as string | null | undefined) ?? null,
    type: row.type as PaymentTransferRow["type"],
    kind: row.kind,
    direction: row.direction as PaymentTransferRow["direction"],
    status: row.status as PaymentTransferRow["status"],
    provider: storedTransferProviderSchema.parse(row.provider),
    provider_reference: row.provider_reference as string | null,
    delivery_mode: row.delivery_mode as PaymentTransferRow["delivery_mode"],
    fiat_currency: row.fiat_currency as string | null,
    fiat_amount: row.fiat_amount as string | null,
    ramps_memo: row.ramps_memo as Record<string, string>,
    provider_data: row.provider_data as Record<string, unknown>,
    signature: (row.signature as string | null | undefined) ?? null,
    serialized_tx: (row.serialized_tx as string | null | undefined) ?? null,
    signed_transaction: (row.signed_transaction as string | null | undefined) ?? null,
    last_valid_block_height: (row.last_valid_block_height as string | null | undefined) ?? null,
    submission_started_at: (row.submission_started_at as string | null | undefined) ?? null,
    slot: (row.slot as number | null | undefined) ?? null,
    block_time: (row.block_time as string | null | undefined) ?? null,
    fee: (row.fee as number | null | undefined) ?? null,
    error: (row.error as string | null | undefined) ?? null,
    initiated_by_key_id: (row.initiated_by_key_id as string | null | undefined) ?? null,
    idempotency_key: (row.idempotency_key as string | null | undefined) ?? null,
    idempotency_fingerprint: (row.idempotency_fingerprint as string | null | undefined) ?? null,
    confirmed_at: (row.confirmed_at as string | null | undefined) ?? null,
    finalization_last_polled_at:
      (row.finalization_last_polled_at as string | null | undefined) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

function buildTransferScopeWhere(params: {
  organizationId: string;
  projectId: string | null;
  includeAllOrganizationProjects?: boolean;
  tableAlias?: string;
  extraClauses?: string[];
  extraValues?: unknown[];
}) {
  const prefix = params.tableAlias ? `${params.tableAlias}.` : "";
  const clauses = [`${prefix}organization_id = ?`];
  const values: unknown[] = [params.organizationId];

  if (!params.includeAllOrganizationProjects) {
    clauses.push(`${prefix}project_id = ?`);
    values.push(params.projectId);
  }

  if (params.extraClauses?.length) {
    clauses.push(...params.extraClauses);
  }

  if (params.extraValues?.length) {
    values.push(...params.extraValues);
  }

  return {
    where: clauses.join(" AND "),
    values,
  };
}

function buildUpdateTransferWhere(input: UpdatePaymentTransferInput) {
  const clauses = ["id = ?"];
  const values: unknown[] = [input.transferId];

  if (input.organizationId) {
    clauses.push("organization_id = ?");
    values.push(input.organizationId);
  }
  if (input.projectId !== undefined) {
    clauses.push("project_id = ?");
    values.push(input.projectId);
  }
  if (input.expectedStatus !== undefined) {
    clauses.push("status = ?");
    values.push(input.expectedStatus);
  }
  // Ramp statuses move only through RAMP_TRANSFER_TRANSITIONS.
  if (input.status !== undefined) {
    clauses.push("type <> ALL(?)");
    values.push([...RAMP_TRANSFER_TYPES]);
  }

  return { clauses, values };
}

export function createPostgresPaymentsRepository(
  db: DatabaseExecutor,
  tenantScope?: TenantScope
): PaymentsRepository {
  const canAccessAllOrganizationProjects = tenantScope?.projectId === null;
  const assertScope = (claim: { organizationId: string; projectId: string | null }) => {
    if (tenantScope) {
      assertTenantClaim(tenantScope, claim, "PaymentsRepository");
    }
  };
  const updateTransferStatusIf = async (
    input: TransferStatusChangeFields & {
      transferId: string;
      organizationId: string;
      projectId: string;
      updatedAt: string;
    },
    guard: {
      fromStatuses: readonly PaymentTransferStatus[];
      toStatus: PaymentTransferStatus;
      types: readonly RampTransferType[];
    },
    sql: StatusChangeSql
  ): Promise<PaymentTransferRow | null> => {
    assertScope(input);
    const extraClauses = ["id = ?", "status = ANY(?)", "type = ANY(?)", ...sql.clauses];
    const extraValues: unknown[] = [
      input.transferId,
      [...guard.fromStatuses],
      [...guard.types],
      ...sql.clauseValues,
    ];
    const scope = buildTransferScopeWhere({
      organizationId: input.organizationId,
      projectId: input.projectId,
      includeAllOrganizationProjects: canAccessAllOrganizationProjects,
      extraClauses,
      extraValues,
    });

    const assignments = ["status = ?", "updated_at = ?", ...sql.assignments];
    const assignmentValues: unknown[] = [guard.toStatus, input.updatedAt, ...sql.assignmentValues];
    if (input.sourceAddress !== undefined) {
      assignments.push("source_address = ?");
      assignmentValues.push(input.sourceAddress);
    }
    if (input.destinationAddress !== undefined) {
      assignments.push("destination_address = ?");
      assignmentValues.push(input.destinationAddress);
    }
    if (input.signature !== undefined) {
      assignments.push("signature = ?");
      assignmentValues.push(input.signature);
    }
    if (input.serializedTx !== undefined) {
      assignments.push("serialized_tx = ?");
      assignmentValues.push(input.serializedTx);
    }
    if (input.slot !== undefined) {
      assignments.push("slot = ?");
      assignmentValues.push(input.slot);
    }
    if (input.blockTime !== undefined) {
      assignments.push("block_time = ?");
      assignmentValues.push(input.blockTime);
    }
    if (input.fee !== undefined) {
      assignments.push("fee = ?");
      assignmentValues.push(input.fee);
    }
    if (input.amount !== undefined) {
      assignments.push("amount = ?");
      assignmentValues.push(input.amount);
    }
    if (input.fiatAmount !== undefined) {
      assignments.push("fiat_amount = ?");
      assignmentValues.push(input.fiatAmount);
    }
    if (input.deliveryMode !== undefined) {
      assignments.push("delivery_mode = ?");
      assignmentValues.push(input.deliveryMode);
    }
    if (input.providerData !== undefined) {
      assignments.push("provider_data = provider_data || ?::jsonb");
      assignmentValues.push(JSON.stringify(input.providerData));
    }
    if (input.error !== undefined) {
      assignments.push("error = ?");
      assignmentValues.push(input.error);
    }
    const row = await db
      .prepare(
        `WITH pt AS (
         UPDATE payment_transfers
         SET ${assignments.join(", ")}
         WHERE ${scope.where}
         RETURNING *
         )
         SELECT pt.*, ${PAYMENT_TRANSACTION_KIND_SQL} AS kind FROM pt`
      )
      .bind(...assignmentValues, ...scope.values)
      .first<PaymentTransferProjectionRow>();

    return row ? mapTransferRow(row) : null;
  };
  const applyRampTransition = (input: RampTransferTransitionInput, sql: StatusChangeSql) => {
    const transition = RAMP_TRANSFER_TRANSITIONS[input.transition];
    return updateTransferStatusIf(
      input,
      { fromStatuses: transition.from, toStatus: transition.to, types: transition.types },
      sql
    );
  };
  return {
    async createTransfer(input: CreatePaymentTransferInput) {
      assertScope(input);
      const row = await db
        .prepare(
          `WITH pt AS (
           INSERT INTO payment_transfers (
             id,
             organization_id,
             project_id,
             custody_wallet_id,
             wallet_id,
             counterparty_id,
             source_address,
             destination_address,
             token,
             amount,
             memo,
             type,
             direction,
             status,
             provider,
             provider_reference,
             delivery_mode,
             fiat_currency,
             fiat_amount,
             ramps_memo,
             provider_data,
             serialized_tx,
             signature,
             slot,
             initiated_by_key_id,
             idempotency_key,
             idempotency_fingerprint,
             confirmed_at,
             created_at,
             updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?, ?, ?, ?, ?, CASE WHEN ?::boolean THEN sdp_iso_now() END, sdp_iso_now(), sdp_iso_now())
           RETURNING *
           )
           SELECT pt.*, ${PAYMENT_TRANSACTION_KIND_SQL} AS kind FROM pt`
        )
        .bind(
          input.id,
          input.organizationId,
          input.projectId,
          input.custodyWalletId,
          input.walletId,
          input.counterpartyId,
          input.sourceAddress,
          input.destinationAddress,
          input.token,
          input.amount,
          input.memo,
          input.type,
          input.direction,
          input.status,
          input.provider,
          input.providerReference,
          input.deliveryMode,
          input.fiatCurrency,
          input.fiatAmount,
          JSON.stringify(input.rampsMemo === undefined ? {} : input.rampsMemo),
          JSON.stringify(input.providerData),
          input.serializedTx,
          input.signature,
          input.slot,
          input.initiatedByKeyId,
          input.idempotencyKey ?? null,
          input.idempotencyFingerprint ?? null,
          input.status === "confirmed"
        )
        .first<PaymentTransferProjectionRow>();

      return row ? mapTransferRow(row) : null;
    },

    async findTransferByIdempotency({ organizationId, projectId, idempotencyKey }) {
      assertScope({ organizationId, projectId });
      const row = await db
        .prepare(
          `SELECT pt.*, ${PAYMENT_TRANSACTION_KIND_SQL} AS kind
           FROM payment_transfers pt
           WHERE pt.organization_id = ?
             AND COALESCE(pt.project_id, '') = COALESCE(?, '')
             AND pt.idempotency_key = ?`
        )
        .bind(organizationId, projectId, idempotencyKey)
        .first<PaymentTransferProjectionRow>();

      return row ? mapTransferRow(row) : null;
    },

    async updateTransfer(input: UpdatePaymentTransferInput) {
      if (tenantScope) {
        if (input.organizationId !== undefined) {
          assertTenantClaim(
            tenantScope,
            {
              organizationId: input.organizationId,
              projectId: input.projectId ?? tenantScope.projectId,
            },
            "PaymentsRepository"
          );
        }
        input = {
          ...input,
          organizationId: tenantScope.organizationId,
          projectId: canAccessAllOrganizationProjects ? undefined : tenantScope.projectId,
        };
      }
      const { clauses, values } = buildUpdateTransferWhere(input);

      const row = await db
        .prepare(
          `WITH pt AS (
           UPDATE payment_transfers
           SET status = COALESCE(?, status),
               signature = CASE WHEN ?::boolean THEN ? ELSE signature END,
               serialized_tx = CASE WHEN ?::boolean THEN ? ELSE serialized_tx END,
               slot = CASE WHEN ?::boolean THEN ? ELSE slot END,
               block_time = CASE WHEN ?::boolean THEN ? ELSE block_time END,
               fee = CASE WHEN ?::boolean THEN ? ELSE fee END,
               amount = CASE WHEN ?::boolean THEN ? ELSE amount END,
               fiat_amount = CASE WHEN ?::boolean THEN ? ELSE fiat_amount END,
               provider_reference = CASE WHEN ?::boolean THEN ? ELSE provider_reference END,
               delivery_mode = CASE WHEN ?::boolean THEN ? ELSE delivery_mode END,
               provider_data = CASE WHEN ?::boolean THEN provider_data || ?::jsonb ELSE provider_data END,
               error = CASE WHEN ?::boolean THEN ? ELSE error END,
               confirmed_at = CASE WHEN ?::boolean THEN COALESCE(confirmed_at, ?) ELSE confirmed_at END,
               updated_at = ?
           WHERE ${clauses.join(" AND ")}
           RETURNING *
           )
           SELECT pt.*, ${PAYMENT_TRANSACTION_KIND_SQL} AS kind FROM pt`
        )
        .bind(
          input.status ?? null,
          input.signature !== undefined,
          input.signature ?? null,
          input.serializedTx !== undefined,
          input.serializedTx ?? null,
          input.slot !== undefined,
          input.slot ?? null,
          input.blockTime !== undefined,
          input.blockTime ?? null,
          input.fee !== undefined,
          input.fee ?? null,
          input.amount !== undefined,
          input.amount ?? null,
          input.fiatAmount !== undefined,
          input.fiatAmount ?? null,
          input.providerReference !== undefined,
          input.providerReference ?? null,
          input.deliveryMode !== undefined,
          input.deliveryMode ?? null,
          input.providerData !== undefined,
          JSON.stringify(input.providerData ?? {}),
          input.error !== undefined,
          input.error ?? null,
          input.status === "confirmed" || input.status === "finalized",
          input.updatedAt,
          input.updatedAt,
          ...values
        )
        .first<PaymentTransferProjectionRow>();

      return row ? mapTransferRow(row) : null;
    },

    async persistSignedTransfer(input) {
      assertScope(input);
      const scope = buildTransferScopeWhere({
        organizationId: input.organizationId,
        projectId: input.projectId,
        includeAllOrganizationProjects: canAccessAllOrganizationProjects,
        extraClauses: [
          "id = ?",
          "status = 'processing'",
          "signature IS NULL",
          "signed_transaction IS NULL",
          "last_valid_block_height IS NULL",
          "submission_started_at IS NULL",
        ],
        extraValues: [input.transferId],
      });
      const row = await db
        .prepare(
          `WITH pt AS (
           UPDATE payment_transfers
           SET signature = ?,
               signed_transaction = ?,
               last_valid_block_height = ?::numeric,
               updated_at = ?
           WHERE ${scope.where}
           RETURNING *
           )
           SELECT pt.*, ${PAYMENT_TRANSACTION_KIND_SQL} AS kind FROM pt`
        )
        .bind(
          input.signature,
          input.signedTransaction,
          input.lastValidBlockHeight,
          input.updatedAt,
          ...scope.values
        )
        .first<PaymentTransferProjectionRow>();

      return row ? mapTransferRow(row) : null;
    },

    async updateOnchainTransferForRamp(input) {
      return applyRampTransition(
        {
          transferId: input.transferId,
          organizationId: input.organizationId,
          projectId: input.projectId,
          transition: "offramp_deposit_claimed",
          destinationAddress: input.destinationAddress,
          error: null,
          updatedAt: input.updatedAt,
        },
        {
          clauses: [
            "direction = 'outbound'",
            "custody_wallet_id = ?",
            "wallet_id = ?",
            "source_address = ?",
            "token = ?",
            "amount::numeric = ?::numeric",
            "provider_data #>> '{cryptoDeposit,destinationAddress}' = ?",
            "(provider_data #>> '{cryptoDeposit,amount}')::numeric = ?::numeric",
            "destination_address IS NULL",
            "signature IS NULL",
            "serialized_tx IS NULL",
            "signed_transaction IS NULL",
            "last_valid_block_height IS NULL",
            "submission_started_at IS NULL",
            "slot IS NULL",
            "block_time IS NULL",
            "fee IS NULL",
          ],
          clauseValues: [
            input.custodyWalletId,
            input.walletId,
            input.sourceAddress,
            input.token,
            input.amount,
            input.destinationAddress,
            input.amount,
          ],
          assignments: [
            "initiated_by_key_id = ?",
            "idempotency_key = COALESCE(?, idempotency_key)",
            "idempotency_fingerprint = COALESCE(?, idempotency_fingerprint)",
          ],
          assignmentValues: [
            input.initiatedByKeyId,
            input.idempotency?.key ?? null,
            input.idempotency?.fingerprint ?? null,
          ],
        }
      );
    },

    async markTransferSubmissionStarted(input) {
      assertScope(input);
      const scope = buildTransferScopeWhere({
        organizationId: input.organizationId,
        projectId: input.projectId,
        includeAllOrganizationProjects: canAccessAllOrganizationProjects,
        extraClauses: [
          "id = ?",
          "status = 'processing'",
          "signature IS NOT NULL",
          "signed_transaction IS NOT NULL",
          "last_valid_block_height IS NOT NULL",
          "submission_started_at IS NULL",
        ],
        extraValues: [input.transferId],
      });
      const row = await db
        .prepare(
          `WITH pt AS (
           UPDATE payment_transfers
           SET submission_started_at = ?, updated_at = ?
           WHERE ${scope.where}
           RETURNING *
           )
           SELECT pt.*, ${PAYMENT_TRANSACTION_KIND_SQL} AS kind FROM pt`
        )
        .bind(input.startedAt, input.startedAt, ...scope.values)
        .first<PaymentTransferProjectionRow>();

      return row ? mapTransferRow(row) : null;
    },

    async transitionRampTransfer(input) {
      return applyRampTransition(input, NO_STATUS_CHANGE_SQL);
    },

    async getTransferById(params) {
      assertScope(params);
      const scope = buildTransferScopeWhere({
        organizationId: params.organizationId,
        projectId: params.projectId,
        includeAllOrganizationProjects: canAccessAllOrganizationProjects,
        tableAlias: "pt",
        extraClauses: ["pt.id = ?"],
        extraValues: [params.transferId],
      });

      const row = await db
        .prepare(
          `SELECT pt.*, ${PAYMENT_TRANSACTION_KIND_SQL} AS kind
           FROM payment_transfers pt WHERE ${scope.where}`
        )
        .bind(...scope.values)
        .first<PaymentTransferProjectionRow>();

      return row ? mapTransferRow(row) : null;
    },

    async getTransferBySignature(params) {
      assertScope(params);
      const scope = buildTransferScopeWhere({
        organizationId: params.organizationId,
        projectId: params.projectId,
        includeAllOrganizationProjects: canAccessAllOrganizationProjects,
        tableAlias: "pt",
        extraClauses: ["pt.signature = ?"],
        extraValues: [params.signature],
      });

      const row = await db
        .prepare(
          `SELECT pt.*, ${PAYMENT_TRANSACTION_KIND_SQL} AS kind
           FROM payment_transfers pt WHERE ${scope.where}`
        )
        .bind(...scope.values)
        .first<PaymentTransferProjectionRow>();

      return row ? mapTransferRow(row) : null;
    },

    async listTransfersByIds(params) {
      assertScope(params);
      if (params.transferIds.length === 0) {
        return [];
      }

      const scope = buildTransferScopeWhere({
        organizationId: params.organizationId,
        projectId: params.projectId,
        includeAllOrganizationProjects: canAccessAllOrganizationProjects,
        tableAlias: "pt",
        extraClauses: ["pt.id = ANY(?)"],
        extraValues: [params.transferIds],
      });

      const rows = await db
        .prepare(
          `SELECT pt.*, ${PAYMENT_TRANSACTION_KIND_SQL} AS kind
           FROM payment_transfers pt WHERE ${scope.where}`
        )
        .bind(...scope.values)
        .all<PaymentTransferProjectionRow>();

      return rows.results.map(mapTransferRow);
    },

    async getTransferByProviderReference(params) {
      if (tenantScope && params.organizationId !== undefined) {
        assertScope({
          organizationId: params.organizationId,
          projectId: params.projectId,
        });
      }
      const effectiveOrganizationId = tenantScope?.organizationId ?? params.organizationId;
      const effectiveProjectId = tenantScope?.projectId ?? params.projectId;
      const scope = effectiveOrganizationId
        ? buildTransferScopeWhere({
            organizationId: effectiveOrganizationId,
            projectId: effectiveProjectId ?? null,
            includeAllOrganizationProjects: canAccessAllOrganizationProjects,
            tableAlias: "pt",
            extraClauses: ["pt.provider = ?", "pt.provider_reference = ?"],
            extraValues: [params.provider, params.providerReference],
          })
        : {
            where: "pt.provider = ? AND pt.provider_reference = ?",
            values: [params.provider, params.providerReference],
          };

      const row = await db
        .prepare(
          `SELECT pt.*, ${PAYMENT_TRANSACTION_KIND_SQL} AS kind
           FROM payment_transfers pt
           WHERE ${scope.where}`
        )
        .bind(...scope.values)
        .first<PaymentTransferProjectionRow>();

      return row ? mapTransferRow(row) : null;
    },

    async getTransferProjectEnvironment(input) {
      const scope = tenantScope
        ? buildTransferScopeWhere({
            organizationId: tenantScope.organizationId,
            projectId: tenantScope.projectId,
            includeAllOrganizationProjects: canAccessAllOrganizationProjects,
            tableAlias: "pt",
            extraClauses: ["pt.id = ?", "pt.provider = ?"],
            extraValues: [input.transferId, input.provider],
          })
        : {
            where: "pt.id = ? AND pt.provider = ?",
            values: [input.transferId, input.provider],
          };
      const row = await db
        .prepare(
          `SELECT p.environment FROM payment_transfers pt
           JOIN projects p ON p.id = pt.project_id
           WHERE ${scope.where}`
        )
        .bind(...scope.values)
        .first<{ environment: unknown }>();
      return row ? z.enum(SDP_ENVIRONMENTS).parse(row.environment) : null;
    },

    async setProviderReferenceIfEmpty(input) {
      const clauses = ["id = ?", "provider = ?"];
      const values: unknown[] = [input.transferId, input.provider];
      if (tenantScope) {
        clauses.push("organization_id = ?", "project_id IS NOT DISTINCT FROM ?");
        values.push(tenantScope.organizationId, tenantScope.projectId);
      }
      const row = await db
        .prepare(
          `WITH pt AS (
           UPDATE payment_transfers
           SET provider_reference = ?, updated_at = ?
           WHERE ${clauses.join(" AND ")}
             AND (provider_reference IS NULL OR provider_reference = ?)
             AND EXISTS (
               SELECT 1 FROM projects p
               WHERE p.id = payment_transfers.project_id AND p.environment = ?
             )
           RETURNING *
           )
           SELECT pt.*, ${PAYMENT_TRANSACTION_KIND_SQL} AS kind FROM pt`
        )
        .bind(
          input.providerReference,
          input.updatedAt,
          ...values,
          input.providerReference,
          input.environment
        )
        .first<PaymentTransferProjectionRow>();

      return row ? mapTransferRow(row) : null;
    },

    async listTransfersBySignatures(params) {
      assertScope(params);
      if (params.signatures.length === 0) {
        return [];
      }

      const scope = buildTransferScopeWhere({
        organizationId: params.organizationId,
        projectId: params.projectId,
        includeAllOrganizationProjects: canAccessAllOrganizationProjects,
        tableAlias: "pt",
        extraClauses: [`pt.signature IN (${buildInClause(params.signatures.length)})`],
        extraValues: params.signatures,
      });

      const rows = await db
        .prepare(
          `SELECT pt.*, ${PAYMENT_TRANSACTION_KIND_SQL} AS kind, c.display_name AS counterparty_display_name
           FROM payment_transfers pt
           LEFT JOIN counterparties c
             ON c.id = pt.counterparty_id
            AND c.organization_id = pt.organization_id
            AND c.project_id = pt.project_id
           WHERE ${scope.where}`
        )
        .bind(...scope.values)
        .all<PaymentTransferProjectionRow>();

      return rows.results.map(mapTransferRow);
    },

    async listTransfers(params: ListTransfersInput): Promise<ListTransfersResult> {
      assertScope(params);
      const { whereClause, values } = buildTransferListWhere(params);
      const paginationValues = [...values, params.limit, params.offset];
      const sort = {
        amount: { column: "NULLIF(pt.amount, '')::numeric", nulls: " NULLS LAST" },
        createdAt: { column: "pt.created_at", nulls: "" },
        status: { column: "pt.status", nulls: "" },
        updatedAt: { column: "pt.updated_at", nulls: "" },
      }[params.sortBy ?? "createdAt"] ?? { column: "pt.created_at", nulls: "" };
      const sortDirection = params.sortDirection === "asc" ? "ASC" : "DESC";

      const [rows, countRow] = await Promise.all([
        db
          .prepare(
            `SELECT pt.*, ${PAYMENT_TRANSACTION_KIND_SQL} AS kind, c.display_name AS counterparty_display_name
             FROM payment_transfers pt
             LEFT JOIN counterparties c
               ON c.id = pt.counterparty_id
              AND c.organization_id = pt.organization_id
              AND c.project_id = pt.project_id
             WHERE ${whereClause}
             ORDER BY ${sort.column} ${sortDirection}${sort.nulls}, pt.created_at DESC, pt.id DESC
             LIMIT ?
             OFFSET ?`
          )
          .bind(...paginationValues)
          .all<PaymentTransferProjectionRow>(),
        db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM payment_transfers pt
             WHERE ${whereClause}`
          )
          .bind(...values)
          .first<{ count: number }>(),
      ]);

      return {
        rows: rows.results.map(mapTransferRow),
        total: countRow?.count ?? 0,
      };
    },

    async listTransfersByStatus({
      environment,
      statuses,
      types,
      hasSignature,
      createdBefore,
      updatedBefore,
      limit,
      offset,
    }: ListTransfersByStatusInput) {
      if (tenantScope) {
        throw new TenantScopeViolationError(
          "PaymentsRepository.listTransfersByStatus is system-only"
        );
      }
      if (statuses.length === 0) {
        return [];
      }

      const clauses = ["p.environment = ?", `pt.status IN (${buildInClause(statuses.length)})`];
      const values: unknown[] = [environment, ...statuses];

      if (types?.length) {
        clauses.push(`pt.type IN (${buildInClause(types.length)})`);
        values.push(...types);
      }
      if (hasSignature === true) {
        clauses.push("pt.signature IS NOT NULL");
      } else if (hasSignature === false) {
        clauses.push("pt.signature IS NULL");
      }
      if (createdBefore) {
        clauses.push("pt.created_at < ?");
        values.push(createdBefore);
      }
      if (updatedBefore) {
        clauses.push("pt.updated_at < ?");
        values.push(updatedBefore);
      }

      const rows = await db
        .prepare(
          `SELECT pt.*, ${PAYMENT_TRANSACTION_KIND_SQL} AS kind
           FROM payment_transfers pt
           JOIN projects p ON p.id = pt.project_id
           WHERE ${clauses.join(" AND ")}
           ORDER BY pt.updated_at ASC, pt.id ASC
           LIMIT ?
           OFFSET ?`
        )
        .bind(...values, limit, offset ?? 0)
        .all<PaymentTransferProjectionRow>();

      return rows.results.map(mapTransferRow);
    },

    async listConfirmedTransfersToPoll({ environment, confirmedAfter, limit }) {
      if (tenantScope) {
        throw new TenantScopeViolationError(
          "PaymentsRepository.listConfirmedTransfersToPoll is system-only"
        );
      }
      const pollableStatus: PaymentTransferStatus = "confirmed";
      const rows = await db
        .prepare(
          `SELECT pt.*, ${PAYMENT_TRANSACTION_KIND_SQL} AS kind
           FROM payment_transfers pt
           JOIN projects p ON p.id = pt.project_id
           WHERE p.environment = ?
             AND pt.status = ?
             AND pt.type IN (${buildInClause(WALLET_TRANSFER_TYPES.length)})
             AND pt.signature IS NOT NULL
             AND pt.confirmed_at > ?
           ORDER BY pt.finalization_last_polled_at ASC NULLS FIRST, pt.id ASC
           LIMIT ?`
        )
        .bind(environment, pollableStatus, ...WALLET_TRANSFER_TYPES, confirmedAfter, limit)
        .all<PaymentTransferProjectionRow>();

      return rows.results.map(mapTransferRow);
    },

    async advanceConfirmedTransfers({ polled, updatedAt }) {
      if (tenantScope) {
        throw new TenantScopeViolationError(
          "PaymentsRepository.advanceConfirmedTransfers is system-only"
        );
      }
      if (polled.length === 0) {
        return;
      }

      const fromStatus: PaymentTransferStatus = "confirmed";
      const toStatus: PaymentTransferStatus = "finalized";
      await db
        .prepare(
          `UPDATE payment_transfers AS t
              SET status = CASE WHEN v.finalized THEN ? ELSE t.status END,
                  slot = CASE WHEN v.finalized THEN v.slot ELSE t.slot END,
                  updated_at = CASE WHEN v.finalized THEN ? ELSE t.updated_at END,
                  finalization_last_polled_at = ?
             FROM jsonb_to_recordset(?::jsonb) AS v(transfer_id text, organization_id text, finalized boolean, slot bigint)
            WHERE t.id = v.transfer_id
              AND t.organization_id = v.organization_id
              AND t.status = ?`
        )
        .bind(
          toStatus,
          updatedAt,
          updatedAt,
          JSON.stringify(
            polled.map((t) => ({
              transfer_id: t.transferId,
              organization_id: t.organizationId,
              finalized: t.finalized,
              slot: t.slot,
            }))
          ),
          fromStatus
        )
        .run();
    },
  };
}
