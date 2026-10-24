import type { TokenAsset } from "@sdp/solana/asset-ref";
import { type BaseUnits, parseBaseUnits } from "@sdp/solana/token-amount";
import { TOKEN_PROGRAM_KINDS } from "@sdp/types/well-known-tokens";
import { address } from "@solana/kit";
import { z } from "zod";

/**
 * A recurring mandate (ADR 0012, migration 0185): what each pull of a
 * recurring payment or a subscription plan debits, in base units, stored once
 * when the mandate is made. Mandates are debit-only: the subscriptions
 * program's plan cap counts the debit.
 */
export type RecurringMandate = Readonly<{
  asset: TokenAsset;
  /** The decimals the mint's terms had when the mandate was made. */
  decimals: number;
  /** What each pull debits. */
  debit: BaseUnits;
  /**
   * The fee tolerance: the largest transfer fee one pull may pay. A pull whose
   * fee would be above it is held.
   */
  maxFeePerPull: BaseUnits;
}>;

/**
 * The mandate columns, one variant per state: all null on a row written before
 * mandates, or all set for a token (a mandate never names native SOL).
 */
const mandateColumnsSchema = z.discriminatedUnion("asset_kind", [
  z.object({
    asset_kind: z.null(),
    mint: z.null(),
    token_program: z.null(),
    decimals: z.null(),
    mandate_debit: z.null(),
    max_fee_per_pull: z.null(),
  }),
  z.object({
    asset_kind: z.literal("token"),
    mint: z.string(),
    token_program: z.enum(TOKEN_PROGRAM_KINDS),
    decimals: z.number().int(),
    mandate_debit: z.string(),
    max_fee_per_pull: z.string(),
  }),
]);

/**
 * Parses the mandate columns of a `payment_recurring_payments` or
 * `payment_subscription_plans` row.
 *
 * @returns The mandate, or null for a row written before mandates.
 * @throws ZodError when only some of the columns are set (the CHECK forbids it).
 */
export function parseRecurringMandate(row: Record<string, unknown>): RecurringMandate | null {
  const columns = mandateColumnsSchema.parse(row);
  if (columns.asset_kind === null) {
    return null;
  }
  return {
    asset: { kind: "token", mint: address(columns.mint), program: columns.token_program },
    decimals: columns.decimals,
    debit: parseBaseUnits(columns.mandate_debit),
    maxFeePerPull: parseBaseUnits(columns.max_fee_per_pull),
  };
}

/** The mandate columns in the order `MANDATE_VALUES` binds them. */
export const MANDATE_COLUMNS =
  "asset_kind, mint, token_program, decimals, mandate_debit, max_fee_per_pull";

/** Placeholders for `MANDATE_COLUMNS`. */
export const MANDATE_VALUES = "?, ?, ?, ?, ?::numeric, ?::numeric";

/** A value a mandate statement binds: text (base units travel as decimal text), a number, a flag or NULL. */
export type MandateBinding = string | number | boolean | null;

/** A mandate's values, in `MANDATE_COLUMNS` order. */
export function mandateValues(mandate: RecurringMandate): MandateBinding[] {
  return [
    mandate.asset.kind,
    mandate.asset.mint,
    mandate.asset.program,
    mandate.decimals,
    mandate.debit.toString(),
    mandate.maxFeePerPull.toString(),
  ];
}

/**
 * The bindings of an update that sets the mandate columns only when a mandate
 * is given: `CASE WHEN ?::boolean THEN ? ELSE column END` pairs, in
 * `MANDATE_COLUMNS` order.
 */
export function mandateUpdateBindings(mandate: RecurringMandate | undefined): MandateBinding[] {
  if (mandate === undefined) {
    return MANDATE_COLUMNS.split(", ").flatMap(() => [false, null]);
  }
  return mandateValues(mandate).flatMap((value) => [true, value]);
}
