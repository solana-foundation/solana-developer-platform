import type { SdpEnvironment } from "@sdp/types";
import { type AppDb, asTransactionalClient } from "@/db";
import { conflict } from "@/lib/errors";
import {
  ensureEarnMovementFromVaultMovement,
  ensureEarnPositionFromVaultPosition,
  projectEarnMovementFromVaultMovement,
  projectEarnPositionFromVaultPosition,
} from "./earn-movements.repository";

/**
 * Persistence for signed, non-custodial Earn vault movements and holdings.
 *
 * Still the authoritative writer, and additionally MIRRORS every write into the
 * unified `earn_movements`/`earn_positions` ledger in the same transaction
 * (PRO-1705, migrations 0062-0064). Reads switch to the unified tables in a
 * later release; until then the mirror is what keeps them current, and one
 * Postgres transaction is what makes the two shapes unable to diverge.
 */

export function generateEarnVaultPositionId(): string {
  return `earn_vault_position_${crypto.randomUUID()}`;
}

export function generateEarnVaultMovementId(): string {
  return `earn_vault_movement_${crypto.randomUUID()}`;
}

export type EarnVaultMovementDirection = "deposit" | "withdraw";
export type EarnVaultMovementStatus = "pending" | "submitted" | "confirmed" | "failed";

export interface EarnVaultPositionRow {
  id: string;
  organization_id: string;
  project_id: string | null;
  environment: SdpEnvironment;
  provider: string;
  provider_reference: string;
  custody_wallet_id: string;
  share_mint: string;
  token_mint: string;
  label: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  activated_at: string | null;
  closed_at: string | null;
}

export interface EarnVaultMovementRow {
  id: string;
  organization_id: string;
  project_id: string | null;
  environment: SdpEnvironment;
  position_id: string;
  provider: string;
  provider_reference: string;
  custody_wallet_id: string;
  direction: EarnVaultMovementDirection;
  status: EarnVaultMovementStatus;
  requested_amount: string;
  amount: string;
  requested_min_shares_out: string | null;
  min_shares_out: string | null;
  shares: string | null;
  signature: string;
  signed_transaction: string;
  last_valid_block_height: string;
  failure_reason: string | null;
  request_id: string;
  /** Canonical request fingerprint; NOT NULL in migration 0059. */
  idempotency_fingerprint: string;
  created_by: string | null;
  initiated_by_key_id: string | null;
  created_at: string;
  updated_at: string;
  confirmed_at: string | null;
}

export interface CreateSignedEarnVaultDepositIntentInput {
  organizationId: string;
  projectId: string;
  environment: SdpEnvironment;
  provider: string;
  providerReference: string;
  custodyWalletId: string;
  shareMint: string;
  tokenMint: string;
  label: string;
  requestedAmount: string;
  acceptedAmount: string;
  requestedMinSharesOut?: string | null;
  acceptedMinSharesOut?: string | null;
  signature: string;
  signedTransaction: string;
  lastValidBlockHeight: string;
  requestId: string;
  idempotencyFingerprint: string;
  createdBy?: string | null;
  initiatedByKeyId?: string | null;
}

export interface AdvanceEarnVaultMovementInput {
  movementId: string;
  organizationId: string;
  /** Legal source states for this guarded transition. */
  fromStatuses: readonly EarnVaultMovementStatus[];
  toStatus: EarnVaultMovementStatus;
  shares?: string | null;
  failureReason?: string | null;
  confirmedAt?: string | null;
}

export interface EarnVaultPositionCursor {
  createdAt: string;
  id: string;
}

export interface EarnVaultMovementCursor {
  createdAt: string;
  id: string;
}

export interface EarnVaultRepository {
  /**
   * Atomically claim/refresh the position, insert the signed movement, and
   * activate the holding. A divergent idempotency loser throws so the entire
   * claim rolls back; an identical loser returns the winning signed row.
   */
  createSignedDepositIntent(
    input: CreateSignedEarnVaultDepositIntentInput
  ): Promise<{ position: EarnVaultPositionRow; movement: EarnVaultMovementRow; replayed: boolean }>;
  getPositionById(params: {
    organizationId: string;
    environment: SdpEnvironment;
    positionId: string;
  }): Promise<EarnVaultPositionRow | null>;
  listPositions(params: {
    organizationId: string;
    environment: SdpEnvironment;
    /** Always the current project's wallet rows plus organization fallbacks. */
    custodyWalletIds: readonly string[];
    limit: number;
    before: EarnVaultPositionCursor | null;
  }): Promise<{ rows: EarnVaultPositionRow[]; hasMore: boolean }>;
  findMovementByRequestId(params: {
    organizationId: string;
    requestId: string;
  }): Promise<EarnVaultMovementRow | null>;
  getMovementById(params: {
    movementId: string;
    organizationId: string;
  }): Promise<EarnVaultMovementRow | null>;
  /**
   * One workspace's recorded DEPOSITS, newest first, as a bounded keyset page.
   *
   * Scoped by wallet AND project, unlike `listPositions` which scopes by wallet
   * alone. A position is a holding the organization owns; a movement is one
   * project's individual transaction and carries an amount and a signature the
   * position does not.
   */
  listDeposits(params: {
    organizationId: string;
    environment: SdpEnvironment;
    projectId: string;
    custodyWalletIds: readonly string[];
    limit: number;
    before: EarnVaultMovementCursor | null;
    /**
     * `false` returns only movements that can still change. Recovery asks for
     * exactly that, which keeps the page small by construction rather than
     * relying on a client filter over an unbounded history.
     */
    settled?: boolean;
  }): Promise<{ rows: EarnVaultMovementRow[]; hasMore: boolean }>;
  /** Global bounded outbox scan for the reconciliation worker. */
  listUnsettledMovements(limit: number): Promise<EarnVaultMovementRow[]>;
  /** Guarded CAS. Returns null when the row was not in `fromStatuses`. */
  advanceMovement(input: AdvanceEarnVaultMovementInput): Promise<EarnVaultMovementRow | null>;
  listMovements(params: {
    organizationId: string;
    positionId: string;
    limit?: number;
  }): Promise<EarnVaultMovementRow[]>;
}

/**
 * Assert a prior movement under this (organization, request_id) is THIS
 * request's own replay — same project AND same fingerprint — before it is
 * returned as one.
 *
 * THIS FUNCTION IS THE RULE — exported so every site that resolves a replay
 * enforces the same one: the route guard, `depositIntoVault`'s fast sequential
 * preflight, the transaction preflight below, and the concurrent-insert loser.
 * The rule kept re-appearing as a bug precisely because it was re-implemented
 * per site: the route guard was fixed and the repository missed; the repository
 * was fixed and the service fast path missed — each lookup is org-scoped
 * (`(organization_id, request_id)` is the unique index) and the server
 * fingerprint omits the project, so any site that forgets this check hands a
 * sibling project's movement back as the caller's own replay. Do not inline it
 * anywhere; call this.
 *
 * Reachability is not theoretical: the route guard is deliberately skipped for
 * an approved-operation execution (`findEarnVaultDepositIdempotentKeyReplay`
 * returns null so the approval can reach the handler's effect fence), and
 * `wallet_operations` uniqueness is per-PROJECT — so sibling projects can each
 * hold an approval with the same caller-chosen key, and the second to execute
 * used to be handed the first project's movement: its own approved deposit
 * silently never ran, and the sibling's amount and signature came back as the
 * response.
 *
 * A different project answers with the SAME conflict as a divergent
 * fingerprint, deliberately: the key really has been used by a different
 * request, and a distinct message would disclose that a sibling project holds
 * it. `project_id IS NULL` (owner deleted, `ON DELETE SET NULL`) also
 * conflicts — the org-scoped unique index means the key is genuinely burnt
 * either way.
 */
export function assertMovementIsOwnReplay(
  movement: EarnVaultMovementRow,
  request: { projectId: string; idempotencyFingerprint: string }
): void {
  if (
    movement.project_id !== request.projectId ||
    movement.idempotency_fingerprint !== request.idempotencyFingerprint
  ) {
    throw conflict("Idempotency key already used with different request payload");
  }
}

function assertValidMovementTransition(input: AdvanceEarnVaultMovementInput): void {
  if (input.fromStatuses.length === 0) {
    throw new Error("advanceMovement requires at least one source status");
  }
  if (new Set(input.fromStatuses).size !== input.fromStatuses.length) {
    throw new Error("advanceMovement source statuses must be unique");
  }

  const validSources =
    input.toStatus === "submitted"
      ? input.fromStatuses.length === 1 && input.fromStatuses[0] === "pending"
      : (input.toStatus === "confirmed" || input.toStatus === "failed") &&
        input.fromStatuses.every((status) => status === "pending" || status === "submitted");
  if (!validSources) {
    throw new Error(
      `Illegal earn vault movement transition: ${input.fromStatuses.join("|")} -> ${input.toStatus}`
    );
  }
  if (input.failureReason !== undefined && input.toStatus !== "failed") {
    throw new Error("failureReason is only valid when failing an earn vault movement");
  }
  if (input.confirmedAt !== undefined && input.toStatus !== "confirmed") {
    throw new Error("confirmedAt is only valid when confirming an earn vault movement");
  }
  if (input.shares !== undefined && input.toStatus !== "confirmed") {
    throw new Error("shares are only valid when confirming an earn vault movement");
  }
  if (
    input.shares !== undefined &&
    input.shares !== null &&
    (input.shares.length < 1 ||
      input.shares.length > 128 ||
      !/^\d+(?:\.\d+)?$/.test(input.shares) ||
      !/[1-9]/.test(input.shares))
  ) {
    throw new Error("shares must be a positive unsigned decimal with at most 128 characters");
  }
  if (input.toStatus === "confirmed" && !input.confirmedAt?.trim()) {
    throw new Error("confirmedAt is required when confirming an earn vault movement");
  }
  if (input.toStatus === "failed" && !input.failureReason?.trim()) {
    throw new Error("failureReason is required when failing an earn vault movement");
  }
}

async function findMovementByRequestId(
  db: AppDb,
  organizationId: string,
  requestId: string
): Promise<EarnVaultMovementRow | null> {
  return db
    .prepare(`SELECT * FROM earn_vault_movements WHERE organization_id = ? AND request_id = ?`)
    .bind(organizationId, requestId)
    .first<EarnVaultMovementRow>();
}

async function getPositionById(
  db: AppDb,
  params: { organizationId: string; environment: SdpEnvironment; positionId: string }
): Promise<EarnVaultPositionRow | null> {
  return db
    .prepare(
      `SELECT * FROM earn_vault_positions
       WHERE id = ? AND organization_id = ? AND environment = ?`
    )
    .bind(params.positionId, params.organizationId, params.environment)
    .first<EarnVaultPositionRow>();
}

async function requireMovementPosition(
  db: AppDb,
  movement: EarnVaultMovementRow
): Promise<EarnVaultPositionRow> {
  const position = await getPositionById(db, {
    organizationId: movement.organization_id,
    environment: movement.environment,
    positionId: movement.position_id,
  });
  if (!position) {
    throw new Error(
      `Earn vault movement ${movement.id} references missing position ${movement.position_id}`
    );
  }
  return position;
}

async function claimPosition(
  db: AppDb,
  input: CreateSignedEarnVaultDepositIntentInput
): Promise<EarnVaultPositionRow> {
  const row = await db
    .prepare(
      `INSERT INTO earn_vault_positions (
         id, organization_id, project_id, environment,
         provider, provider_reference, custody_wallet_id,
         share_mint, token_mint, label, created_by, activated_at
       )
       SELECT
         ?, project.organization_id, project.id, project.environment,
         ?, ?, wallet.id, ?, ?, ?, ?, sdp_iso_now()
       FROM projects project
       INNER JOIN custody_wallets wallet
         ON wallet.id = ?
       LEFT JOIN custody_configs config
         ON config.id = wallet.custody_config_id
       LEFT JOIN custody_connections connection
         ON connection.id = wallet.custody_connection_id
       WHERE project.id = ?
         AND project.organization_id = ?
         AND project.environment = ?
         AND (
           (
             wallet.custody_config_id IS NOT NULL
             AND config.organization_id = project.organization_id
             AND (config.project_id IS NULL OR config.project_id = project.id)
           )
           OR
           (
             wallet.custody_connection_id IS NOT NULL
             AND connection.organization_id = project.organization_id
             AND (connection.project_id IS NULL OR connection.project_id = project.id)
           )
         )
       ON CONFLICT (organization_id, environment, provider, provider_reference, custody_wallet_id)
       DO UPDATE SET
         updated_at = sdp_iso_now(),
         label = EXCLUDED.label,
         activated_at = COALESCE(earn_vault_positions.activated_at, sdp_iso_now())
       WHERE earn_vault_positions.token_mint = EXCLUDED.token_mint
         AND earn_vault_positions.share_mint = EXCLUDED.share_mint
       RETURNING *`
    )
    .bind(
      generateEarnVaultPositionId(),
      input.provider,
      input.providerReference,
      input.shareMint,
      input.tokenMint,
      input.label,
      input.createdBy ?? null,
      input.custodyWalletId,
      input.projectId,
      input.organizationId,
      input.environment
    )
    .first<EarnVaultPositionRow>();
  if (!row) {
    throw conflict("Vault position does not match project, wallet scope, or asset identity");
  }
  return row;
}

async function insertMovement(
  db: AppDb,
  input: CreateSignedEarnVaultDepositIntentInput,
  positionId: string
): Promise<EarnVaultMovementRow | null> {
  return db
    .prepare(
      `INSERT INTO earn_vault_movements (
         id, organization_id, project_id, environment, position_id,
         provider, provider_reference, custody_wallet_id,
         direction, request_id, idempotency_fingerprint,
         requested_amount, amount, requested_min_shares_out, min_shares_out,
         signature, signed_transaction, last_valid_block_height,
         created_by, initiated_by_key_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'deposit', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (organization_id, request_id) DO NOTHING
       RETURNING *`
    )
    .bind(
      generateEarnVaultMovementId(),
      input.organizationId,
      input.projectId,
      input.environment,
      positionId,
      input.provider,
      input.providerReference,
      input.custodyWalletId,
      input.requestId,
      input.idempotencyFingerprint,
      input.requestedAmount,
      input.acceptedAmount,
      input.requestedMinSharesOut ?? null,
      input.acceptedMinSharesOut ?? null,
      input.signature,
      input.signedTransaction,
      input.lastValidBlockHeight,
      input.createdBy ?? null,
      input.initiatedByKeyId ?? null
    )
    .first<EarnVaultMovementRow>();
}

export function createPostgresEarnVaultRepository(db: AppDb): EarnVaultRepository {
  return {
    async createSignedDepositIntent(input) {
      // This remains a real transaction for ordinary requests. When the caller
      // supplied an approved-operation transaction, asTransactionalClient makes
      // this nested call execute inline on that same connection.
      return db.transaction(async (executor) => {
        const transaction = asTransactionalClient(executor);

        const prior = await findMovementByRequestId(
          transaction,
          input.organizationId,
          input.requestId
        );
        if (prior) {
          assertMovementIsOwnReplay(prior, input);
          const position = await requireMovementPosition(transaction, prior);
          // A replay writes no legacy row, but it is still the path a caller
          // retrying an unmirrored row takes — so repair rather than answer 200
          // while the ledger is still missing the movement. `ensure`, because a
          // replay changes nothing about the holding and this runs concurrently
          // with the winning request's own writes.
          await ensureEarnPositionFromVaultPosition(transaction, position.id);
          await ensureEarnMovementFromVaultMovement(transaction, prior.id);
          return { position, movement: prior, replayed: true };
        }

        const claimed = await claimPosition(transaction, input);
        // Mirror the holding before the movement: the ledger's tenancy and
        // exact-claim foreign keys both point at it.
        await projectEarnPositionFromVaultPosition(transaction, claimed.id);
        const inserted = await insertMovement(transaction, input, claimed.id);
        if (!inserted) {
          // A concurrent request committed after the preflight. A divergent
          // fingerprint throws and rolls the claim back with this transaction.
          const winner = await findMovementByRequestId(
            transaction,
            input.organizationId,
            input.requestId
          );
          if (!winner) throw new Error("Failed to resolve concurrent earn vault movement");
          assertMovementIsOwnReplay(winner, input);
          const winnerPosition = await requireMovementPosition(transaction, winner);
          // Same repair as the sequential replay above: the winner projected its
          // own row, but this loser may be the first write to touch a holding
          // that predates the ledger.
          await ensureEarnPositionFromVaultPosition(transaction, winnerPosition.id);
          await ensureEarnMovementFromVaultMovement(transaction, winner.id);
          return { position: winnerPosition, movement: winner, replayed: true };
        }

        await projectEarnMovementFromVaultMovement(transaction, inserted.id);

        return {
          position: claimed,
          movement: inserted,
          replayed: false,
        };
      });
    },

    async getPositionById(params) {
      return getPositionById(db, params);
    },

    async listPositions(params) {
      if (params.custodyWalletIds.length === 0) {
        throw new Error("listPositions requires at least one project-scoped custody wallet id");
      }
      const beforeClause = params.before ? "AND (created_at, id) < (?, ?)" : "";
      const beforeValues = params.before ? [params.before.createdAt, params.before.id] : [];
      const result = await db
        .prepare(
          `SELECT * FROM earn_vault_positions
           WHERE organization_id = ?
             AND environment = ?
             AND activated_at IS NOT NULL
             AND (
               closed_at IS NULL
               OR EXISTS (
                 SELECT 1
                 FROM earn_vault_movements reentry
                 WHERE reentry.position_id = earn_vault_positions.id
                   AND reentry.direction = 'deposit'
                   AND reentry.status IN ('pending', 'submitted')
               )
             )
             AND custody_wallet_id = ANY (?::text[])
             AND EXISTS (
               SELECT 1
               FROM earn_vault_movements movement
               WHERE movement.position_id = earn_vault_positions.id
                 AND movement.status IN ('pending', 'submitted', 'confirmed')
             )
             ${beforeClause}
           ORDER BY created_at DESC, id DESC
           LIMIT ?`
        )
        .bind(
          params.organizationId,
          params.environment,
          params.custodyWalletIds,
          ...beforeValues,
          params.limit + 1
        )
        .all<EarnVaultPositionRow>();
      const rows = result.results ?? [];
      return { rows: rows.slice(0, params.limit), hasMore: rows.length > params.limit };
    },

    async listDeposits(params) {
      if (params.custodyWalletIds.length === 0) {
        throw new Error("listDeposits requires at least one project-scoped custody wallet id");
      }
      const beforeClause = params.before ? "AND (created_at, id) < (?, ?)" : "";
      const beforeValues = params.before ? [params.before.createdAt, params.before.id] : [];
      // Terminal set spelled once, from the same statuses the transition guard
      // above enforces.
      const settledClause =
        params.settled === undefined
          ? ""
          : params.settled
            ? "AND status IN ('confirmed', 'failed')"
            : "AND status NOT IN ('confirmed', 'failed')";
      const result = await db
        .prepare(
          // An EXACT project match. `project_id` is nullable only through
          // ON DELETE SET NULL, so a null means the project was deleted — and
          // accepting it here would expose that project's deposits to every
          // sibling project sharing an organization-level custody wallet.
          `SELECT * FROM earn_vault_movements
           WHERE organization_id = ?
             AND environment = ?
             AND direction = 'deposit'
             AND custody_wallet_id = ANY (?::text[])
             AND project_id = ?
             ${settledClause}
             ${beforeClause}
           ORDER BY created_at DESC, id DESC
           LIMIT ?`
        )
        .bind(
          params.organizationId,
          params.environment,
          params.custodyWalletIds,
          params.projectId,
          ...beforeValues,
          params.limit + 1
        )
        .all<EarnVaultMovementRow>();
      const rows = result.results ?? [];
      return { rows: rows.slice(0, params.limit), hasMore: rows.length > params.limit };
    },

    async findMovementByRequestId(params) {
      return findMovementByRequestId(db, params.organizationId, params.requestId);
    },

    async getMovementById(params) {
      return db
        .prepare(`SELECT * FROM earn_vault_movements WHERE id = ? AND organization_id = ?`)
        .bind(params.movementId, params.organizationId)
        .first<EarnVaultMovementRow>();
    },

    async listUnsettledMovements(limit) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 256) {
        throw new Error("listUnsettledMovements limit must be an integer from 1 to 256");
      }
      const result = await db
        .prepare(
          `SELECT * FROM earn_vault_movements
           WHERE status IN ('pending', 'submitted')
           ORDER BY created_at ASC, id ASC
           LIMIT ?`
        )
        .bind(limit)
        .all<EarnVaultMovementRow>();
      return result.results ?? [];
    },

    async advanceMovement(input) {
      assertValidMovementTransition(input);
      const assignments = ["status = ?", "updated_at = sdp_iso_now()"];
      const values: unknown[] = [input.toStatus];
      if (input.shares !== undefined) {
        assignments.push("shares = ?");
        values.push(input.shares);
      }
      if (input.failureReason !== undefined) {
        assignments.push("failure_reason = ?");
        values.push(input.failureReason);
      }
      if (input.confirmedAt !== undefined) {
        assignments.push("confirmed_at = ?");
        values.push(input.confirmedAt);
      }

      const guards = input.fromStatuses.map(() => "?").join(", ");
      const advance = (target: AppDb) =>
        target
          .prepare(
            `UPDATE earn_vault_movements
               SET ${assignments.join(", ")}
             WHERE id = ? AND organization_id = ? AND status IN (${guards})
             RETURNING *`
          )
          .bind(...values, input.movementId, input.organizationId, ...input.fromStatuses)
          .first<EarnVaultMovementRow>();

      // Every transition now runs in a transaction, including the non-terminal
      // ones that used to be a bare UPDATE: the ledger mirror has to commit with
      // the transition it describes, or a crash between them would leave the two
      // shapes disagreeing about a money movement's state.
      if (input.toStatus !== "failed" && input.toStatus !== "confirmed") {
        return db.transaction(async (executor) => {
          const transaction = asTransactionalClient(executor);
          const movement = await advance(transaction);
          if (!movement) return null;
          // The holding first, as in the terminal branch below. The movement
          // projection INNER JOINs earn_positions, so a movement whose holding
          // was never mirrored — one written by a revision that predates the
          // ledger, or during a rollout window — would otherwise fail here and
          // roll the legacy status write back with it. `ensure` rather than
          // re-project: a non-terminal transition changes no holding state, so
          // there is nothing to refresh, and taking a row lock on the holding
          // here would deadlock against a concurrent flow on the same one.
          await ensureEarnPositionFromVaultPosition(transaction, movement.position_id);
          await projectEarnMovementFromVaultMovement(transaction, movement.id);
          return movement;
        });
      }

      return db.transaction(async (executor) => {
        const transaction = asTransactionalClient(executor);
        const candidate = await transaction
          .prepare(
            `SELECT position_id, direction
             FROM earn_vault_movements
             WHERE id = ? AND organization_id = ?`
          )
          .bind(input.movementId, input.organizationId)
          .first<{ position_id: string; direction: EarnVaultMovementDirection }>();
        if (!candidate) return null;
        await transaction
          .prepare("SELECT id FROM earn_vault_positions WHERE id = ? FOR UPDATE")
          .bind(candidate.position_id)
          .first<{ id: string }>();
        const movement = await advance(transaction);
        if (!movement) return null;
        if (input.toStatus === "confirmed" && candidate.direction === "deposit") {
          await transaction
            .prepare(
              `UPDATE earn_vault_positions
               SET activated_at = COALESCE(activated_at, sdp_iso_now()),
                   closed_at = NULL,
                   updated_at = sdp_iso_now()
               WHERE id = ? AND organization_id = ?`
            )
            .bind(movement.position_id, input.organizationId)
            .run();
        } else if (input.toStatus === "failed") {
          await transaction
            .prepare(
              `UPDATE earn_vault_positions position
               SET activated_at = NULL, updated_at = sdp_iso_now()
               WHERE position.id = ?
                 AND position.activated_at IS NOT NULL
                 AND NOT EXISTS (
                   SELECT 1
                   FROM earn_vault_movements movement
                   WHERE movement.position_id = position.id
                     AND movement.status IN ('pending', 'submitted', 'confirmed')
                 )`
            )
            .bind(movement.position_id)
            .run();
        }
        // A terminal transition can activate or de-activate the holding, so the
        // holding is re-projected too — not just the movement.
        await projectEarnPositionFromVaultPosition(transaction, movement.position_id);
        await projectEarnMovementFromVaultMovement(transaction, movement.id);
        return movement;
      });
    },

    async listMovements(params) {
      const result = await db
        .prepare(
          `SELECT * FROM earn_vault_movements
           WHERE organization_id = ? AND position_id = ?
           ORDER BY created_at DESC, id DESC
           LIMIT ?`
        )
        .bind(params.organizationId, params.positionId, params.limit ?? 50)
        .all<EarnVaultMovementRow>();
      return result.results ?? [];
    },
  };
}
