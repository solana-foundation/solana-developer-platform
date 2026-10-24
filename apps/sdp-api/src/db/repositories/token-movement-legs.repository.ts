import type { AssetRef } from "@sdp/solana/asset-ref";
import type { MovementQuote } from "@sdp/solana/movement-quote";
import { type BaseUnits, parseBaseUnits, toTokenAmount } from "@sdp/solana/token-amount";
import {
  AMOUNT_VERIFICATION_REASONS,
  AMOUNT_VERIFICATION_STATES,
  type AmountVerificationReason,
  type AmountVerificationState,
  type AmountVerificationVerdict,
  TOKEN_MOVEMENT_BASES,
  type TokenMovementBasis,
} from "@sdp/types/token-movements";
import { TOKEN_PROGRAM_KINDS } from "@sdp/types/well-known-tokens";
import { address, type Epoch, type Slot, type UnixTimestamp, unixTimestamp } from "@solana/kit";
import { z } from "zod";
import type { DatabaseExecutor } from "@/db/client";
import { buildInClause } from "@/db/postgres-utils";
import { assertTenantClaim, type TenantScope } from "@/lib/tenant-scope";

/**
 * Token movement legs (ADR 0012, migration 0183): what each movement SDP
 * builds moves, in base units, one row per (movement, destination). This is
 * the only writer. Rows written before quotes have no leg (legacy = no leg).
 *
 * A leg's quote is immutable once its movement has a saved signature: the
 * upsert below refuses it in its predicate, and a trigger refuses it for any
 * writer. Verdicts are written by the statements that settle the movement
 * (`legVerdictStatement`), so a transfer and its legs settle together.
 */

/** The row a leg belongs to. */
const tokenMovementLegOwnerSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("transfer"), transferId: z.string() }),
    z.object({ kind: z.literal("batch_recipient"), recipientId: z.string() }),
  ])
  .readonly();

export type TokenMovementLegOwner = z.infer<typeof tokenMovementLegOwnerSchema>;

/** The three base-unit amounts of a movement; `debit = credit + fee`. */
export type LegAmounts = Readonly<{ debit: BaseUnits; fee: BaseUnits; credit: BaseUnits }>;

/** A leg as the ledger holds it. */
export interface TokenMovementLeg {
  id: string;
  organizationId: string;
  projectId: string;
  owner: TokenMovementLegOwner;
  asset: AssetRef;
  decimals: number;
  basis: TokenMovementBasis;
  quoted: LegAmounts;
  /** The epoch whose fee entry priced the fee; null without a fee config. */
  feeEpoch: Epoch | null;
  /** The Clock read with the mint; null for native SOL. */
  asOf: Readonly<{ slot: Slot; unixTimestamp: UnixTimestamp }> | null;
  /** What the chain shows the movement moved, once checked. */
  observed: LegAmounts | null;
  verification: Readonly<{
    state: AmountVerificationState;
    reason: AmountVerificationReason | null;
  }>;
  createdAt: string;
  updatedAt: string;
}

/** The summed amounts of several legs of one movement, in base units. */
export interface LegTotals {
  basis: TokenMovementBasis;
  decimals: number;
  /** Sums of u64 amounts: a total may pass the u64 range. */
  debit: bigint;
  fee: bigint;
  credit: bigint;
}

/**
 * The summed amounts of legs of one movement.
 *
 * @throws Error when the legs disagree on basis or decimals: they are not one movement.
 */
export function legTotals(legs: readonly [TokenMovementLeg, ...TokenMovementLeg[]]): LegTotals {
  const [first] = legs;
  if (legs.some((leg) => leg.basis !== first.basis || leg.decimals !== first.decimals)) {
    throw new Error("Movement legs disagree on basis or decimals");
  }
  const sum = (part: keyof LegAmounts) => legs.reduce((total, leg) => total + leg.quoted[part], 0n);
  return {
    basis: first.basis,
    decimals: first.decimals,
    debit: sum("debit"),
    fee: sum("fee"),
    credit: sum("credit"),
  };
}

/** A leg to record: its owner and the quote it was built from. */
export interface NewTokenMovementLeg {
  owner: TokenMovementLegOwner;
  quote: MovementQuote;
}

const LEG_PENDING_STATE = "pending" satisfies AmountVerificationState;

const legRowSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  project_id: z.string(),
  payment_transfer_id: z.string().nullable(),
  payment_transfer_recipient_id: z.string().nullable(),
  asset_kind: z.enum(["native", "token"]),
  mint: z.string().nullable(),
  token_program: z.enum(TOKEN_PROGRAM_KINDS).nullable(),
  decimals: z.number().int(),
  basis: z.enum(TOKEN_MOVEMENT_BASES),
  quoted_debit: z.string(),
  quoted_fee: z.string(),
  quoted_credit: z.string(),
  fee_epoch: z.string().nullable(),
  as_of_slot: z.string().nullable(),
  as_of_unix_timestamp: z.number().int().nullable(),
  observed_debit: z.string().nullable(),
  observed_fee: z.string().nullable(),
  observed_credit: z.string().nullable(),
  verification_state: z.enum(AMOUNT_VERIFICATION_STATES),
  verification_reason: z.enum(AMOUNT_VERIFICATION_REASONS).nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

type LegRow = z.infer<typeof legRowSchema>;

/** A sum of non-negative whole numbers, as `sum(...)::text` returns it. */
const wholeNumberSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);

const batchTotalsRowSchema = z.object({
  batch_id: z.string(),
  basis: z.enum(TOKEN_MOVEMENT_BASES),
  bases: z.number().int(),
  decimals: z.number().int(),
  scales: z.number().int(),
  debit: wholeNumberSchema,
  fee: wholeNumberSchema,
  credit: wholeNumberSchema,
});

function legAsset(row: LegRow): AssetRef {
  if (row.asset_kind === "native") {
    return { kind: "native" };
  }
  if (row.mint === null || row.token_program === null) {
    throw new Error(`Token movement leg ${row.id} names no mint`);
  }
  return { kind: "token", mint: address(row.mint), program: row.token_program };
}

function legOwner(row: LegRow): TokenMovementLegOwner {
  if (row.payment_transfer_id !== null) {
    return tokenMovementLegOwnerSchema.parse({
      kind: "transfer",
      transferId: row.payment_transfer_id,
    });
  }
  if (row.payment_transfer_recipient_id !== null) {
    return tokenMovementLegOwnerSchema.parse({
      kind: "batch_recipient",
      recipientId: row.payment_transfer_recipient_id,
    });
  }
  throw new Error(`Token movement leg ${row.id} has no owner`);
}

function amounts(debit: string, fee: string, credit: string): LegAmounts {
  return { debit: parseBaseUnits(debit), fee: parseBaseUnits(fee), credit: parseBaseUnits(credit) };
}

function observedAmounts(row: LegRow): LegAmounts | null {
  const { observed_debit: debit, observed_fee: fee, observed_credit: credit } = row;
  if (debit === null || fee === null || credit === null) {
    return null;
  }
  return amounts(debit, fee, credit);
}

/** Parses a `token_movement_legs` row: the database is a trust boundary too. */
export function parseTokenMovementLegRow(raw: Record<string, unknown>): TokenMovementLeg {
  const row = legRowSchema.parse(raw);
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    owner: legOwner(row),
    asset: legAsset(row),
    decimals: row.decimals,
    basis: row.basis,
    quoted: amounts(row.quoted_debit, row.quoted_fee, row.quoted_credit),
    feeEpoch: row.fee_epoch === null ? null : BigInt(row.fee_epoch),
    asOf:
      row.as_of_slot === null || row.as_of_unix_timestamp === null
        ? null
        : {
            slot: BigInt(row.as_of_slot),
            unixTimestamp: unixTimestamp(BigInt(row.as_of_unix_timestamp)),
          },
    observed: observedAmounts(row),
    verification: { state: row.verification_state, reason: row.verification_reason },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The legacy `amount` text a new outbound row stores: its own wallet's
 * effect, the quote's debit, in token units. Rows SDP builds write `amount`
 * from this alone.
 */
export function ownWalletAmount(quote: MovementQuote): string {
  return toTokenAmount(quote.debit, quote.decimals).value;
}

const LEG_COLUMNS = `id, organization_id, project_id, payment_transfer_id,
  payment_transfer_recipient_id, asset_kind, mint, token_program, decimals, basis,
  quoted_debit, quoted_fee, quoted_credit, fee_epoch, as_of_slot, as_of_unix_timestamp`;

const LEG_VALUES =
  "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::numeric, ?::numeric, ?::numeric, ?::numeric, ?::numeric, ?)";

function generateTokenMovementLegId(): string {
  return `tml_${crypto.randomUUID()}`;
}

/** A value a leg statement binds: text (base units travel as decimal text), a number or NULL. */
export type LegBinding = string | number | null;

/** One leg's values, in `LEG_COLUMNS` order. */
function legValues(tenant: TenantScope, id: string, leg: NewTokenMovementLeg): LegBinding[] {
  const { quote, owner } = leg;
  const asset = quote.intent.asset;
  return [
    id,
    tenant.organizationId,
    tenant.projectId,
    owner.kind === "transfer" ? owner.transferId : null,
    owner.kind === "batch_recipient" ? owner.recipientId : null,
    asset.kind,
    asset.kind === "token" ? asset.mint : null,
    asset.kind === "token" ? asset.program : null,
    quote.decimals,
    quote.intent.basis,
    quote.debit.toString(),
    quote.fee.toString(),
    quote.credit.toString(),
    quote.feeEpoch === null ? null : quote.feeEpoch.toString(),
    quote.asOf === null ? null : quote.asOf.slot.toString(),
    quote.asOf === null ? null : Number(quote.asOf.unixTimestamp),
  ];
}

/**
 * A data-modifying CTE that writes a chain verdict on the pending legs a
 * settling statement's rows own, so the movement and its legs settle in one
 * statement. Bind its values after the statement's own, in text order.
 *
 * @param params.source - The CTE or table alias whose rows own the legs.
 * @param params.ownerColumn - The leg column that names those rows.
 */
export function legVerdictStatement(params: {
  source: string;
  ownerColumn: "payment_transfer_id" | "payment_transfer_recipient_id";
  verdict: AmountVerificationVerdict;
  updatedAt: string;
}): { cte: string; values: LegBinding[] } {
  return {
    cte: `settled_legs AS (
      UPDATE token_movement_legs leg
         SET verification_state = ?, verification_reason = ?, updated_at = ?
        FROM ${params.source} owner_row
       WHERE leg.${params.ownerColumn} = owner_row.id
         AND leg.organization_id = owner_row.organization_id
         AND leg.verification_state = ?
    )`,
    values: [params.verdict.state, params.verdict.reason, params.updatedAt, LEG_PENDING_STATE],
  };
}

/**
 * The tenant-scoped leg repository. Pass a transactional executor to write
 * legs with their owning rows in one transaction.
 */
export function createPostgresTokenMovementLegsRepository(
  db: DatabaseExecutor,
  tenant: TenantScope
) {
  if (tenant.projectId === null) {
    throw new Error("Token movement legs are project-scoped");
  }
  const projectId = tenant.projectId;
  const assertOwnRow = (row: TokenMovementLeg) => {
    assertTenantClaim(tenant, row, "TokenMovementLegsRepository");
    return row;
  };

  return {
    /**
     * Records legs for owning rows written in the same transaction.
     *
     * @returns The legs, in input order.
     */
    async insertLegs(legs: readonly NewTokenMovementLeg[]): Promise<TokenMovementLeg[]> {
      if (legs.length === 0) {
        return [];
      }
      const ids = legs.map(() => generateTokenMovementLegId());
      const values = legs.flatMap((leg, index) => legValues(tenant, ids[index], leg));
      const rows = await db.queryMany(
        `INSERT INTO token_movement_legs (${LEG_COLUMNS})
         VALUES ${legs.map(() => LEG_VALUES).join(", ")}
         RETURNING *`,
        values
      );
      if (rows.length !== legs.length) {
        throw new Error("token_movement_legs INSERT returned an unexpected count");
      }
      const byId = new Map(rows.map((row) => [String(row.id), parseTokenMovementLegRow(row)]));
      return ids.map((id) => {
        const leg = byId.get(id);
        if (leg === undefined) {
          throw new Error(`token_movement_legs INSERT did not return ${id}`);
        }
        return assertOwnRow(leg);
      });
    },

    /**
     * Records a transfer's leg, or replaces its quote while the transfer has
     * no saved signature (an off-ramp deposit claimed again after a release).
     *
     * @returns The leg, or null when the transfer's signature has sealed it.
     */
    async upsertTransferLeg(
      leg: NewTokenMovementLeg & { owner: Extract<TokenMovementLegOwner, { kind: "transfer" }> }
    ): Promise<TokenMovementLeg | null> {
      const row = await db.queryOne(
        `INSERT INTO token_movement_legs (${LEG_COLUMNS})
         VALUES ${LEG_VALUES}
         ON CONFLICT (payment_transfer_id) WHERE payment_transfer_id IS NOT NULL
         DO UPDATE SET asset_kind = excluded.asset_kind,
                       mint = excluded.mint,
                       token_program = excluded.token_program,
                       decimals = excluded.decimals,
                       basis = excluded.basis,
                       quoted_debit = excluded.quoted_debit,
                       quoted_fee = excluded.quoted_fee,
                       quoted_credit = excluded.quoted_credit,
                       fee_epoch = excluded.fee_epoch,
                       as_of_slot = excluded.as_of_slot,
                       as_of_unix_timestamp = excluded.as_of_unix_timestamp,
                       verification_state = ?,
                       verification_reason = NULL,
                       updated_at = sdp_iso_now()
          WHERE token_movement_legs.organization_id = excluded.organization_id
            AND token_movement_legs.project_id = excluded.project_id
            AND NOT EXISTS (
              SELECT 1 FROM payment_transfers movement
               WHERE movement.id = token_movement_legs.payment_transfer_id
                 AND movement.signature IS NOT NULL
            )
         RETURNING *`,
        [...legValues(tenant, generateTokenMovementLegId(), leg), LEG_PENDING_STATE]
      );
      return row === null ? null : assertOwnRow(parseTokenMovementLegRow(row));
    },

    /**
     * The legs of transfer rows: each transfer's own, and a batch chunk's
     * through the recipients it pays.
     *
     * @returns Legs by transfer id; a transfer with no leg is absent.
     */
    async listLegsByTransfers(
      transferIds: readonly string[]
    ): Promise<Map<string, TokenMovementLeg[]>> {
      const byTransfer = new Map<string, TokenMovementLeg[]>();
      if (transferIds.length === 0) {
        return byTransfer;
      }
      const placeholders = buildInClause(transferIds.length);
      // Two indexed lookups: an OR across both sides of one join scans every leg.
      const rows = await db.queryMany(
        `SELECT leg.*, leg.payment_transfer_id AS movement_transfer_id
           FROM token_movement_legs leg
          WHERE leg.organization_id = ?
            AND leg.project_id = ?
            AND leg.status <> 'archived'
            AND leg.payment_transfer_id IN (${placeholders})
         UNION ALL
         SELECT leg.*, recipient.transfer_id AS movement_transfer_id
           FROM payment_transfer_recipients recipient
           JOIN token_movement_legs leg
             ON leg.payment_transfer_recipient_id = recipient.id
            AND leg.organization_id = recipient.organization_id
            AND leg.project_id = recipient.project_id
          WHERE leg.organization_id = ?
            AND leg.project_id = ?
            AND leg.status <> 'archived'
            AND recipient.transfer_id IN (${placeholders})
          ORDER BY created_at, id`,
        [
          tenant.organizationId,
          projectId,
          ...transferIds,
          tenant.organizationId,
          projectId,
          ...transferIds,
        ]
      );
      for (const row of rows) {
        const movement = z.string().parse(row.movement_transfer_id);
        const legs = byTransfer.get(movement) ?? [];
        legs.push(assertOwnRow(parseTokenMovementLegRow(row)));
        byTransfer.set(movement, legs);
      }
      return byTransfer;
    },

    /**
     * The summed legs of each batch's recipients, by batch id; a batch whose
     * recipients have no legs (written before quotes) is absent.
     *
     * @throws Error when a batch's legs disagree on basis or decimals.
     */
    async sumLegsByBatches(batchIds: readonly string[]): Promise<Map<string, LegTotals>> {
      const totals = new Map<string, LegTotals>();
      if (batchIds.length === 0) {
        return totals;
      }
      const rows = await db.queryMany(
        `SELECT recipient.batch_id,
                min(leg.basis) AS basis,
                count(DISTINCT leg.basis)::int AS bases,
                min(leg.decimals) AS decimals,
                count(DISTINCT leg.decimals)::int AS scales,
                sum(leg.quoted_debit)::text AS debit,
                sum(leg.quoted_fee)::text AS fee,
                sum(leg.quoted_credit)::text AS credit
           FROM token_movement_legs leg
           JOIN payment_transfer_recipients recipient
             ON recipient.id = leg.payment_transfer_recipient_id
            AND recipient.organization_id = leg.organization_id
            AND recipient.project_id = leg.project_id
          WHERE leg.organization_id = ?
            AND leg.project_id = ?
            AND leg.status <> 'archived'
            AND recipient.batch_id IN (${buildInClause(batchIds.length)})
          GROUP BY recipient.batch_id`,
        [tenant.organizationId, projectId, ...batchIds]
      );
      for (const raw of rows) {
        const row = batchTotalsRowSchema.parse(raw);
        if (row.bases !== 1 || row.scales !== 1) {
          throw new Error(`Batch ${row.batch_id} legs disagree on basis or decimals`);
        }
        totals.set(row.batch_id, {
          basis: row.basis,
          decimals: row.decimals,
          debit: BigInt(row.debit),
          fee: BigInt(row.fee),
          credit: BigInt(row.credit),
        });
      }
      return totals;
    },

    /** The legs of batch recipients, by recipient id; a recipient with no leg is absent. */
    async listLegsByRecipients(
      recipientIds: readonly string[]
    ): Promise<Map<string, TokenMovementLeg>> {
      const byRecipient = new Map<string, TokenMovementLeg>();
      if (recipientIds.length === 0) {
        return byRecipient;
      }
      const rows = await db.queryMany(
        `SELECT * FROM token_movement_legs
          WHERE organization_id = ?
            AND project_id = ?
            AND status <> 'archived'
            AND payment_transfer_recipient_id IN (${buildInClause(recipientIds.length)})`,
        [tenant.organizationId, projectId, ...recipientIds]
      );
      for (const row of rows) {
        const leg = assertOwnRow(parseTokenMovementLegRow(row));
        if (leg.owner.kind !== "batch_recipient") {
          throw new Error(`Token movement leg ${leg.id} is not a recipient's`);
        }
        byRecipient.set(leg.owner.recipientId, leg);
      }
      return byRecipient;
    },
  };
}

export type TokenMovementLegsRepository = ReturnType<
  typeof createPostgresTokenMovementLegsRepository
>;
