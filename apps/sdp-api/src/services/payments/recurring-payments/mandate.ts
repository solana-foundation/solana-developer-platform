/**
 * Recurring mandates (ADR 0012): what each pull of a recurring payment or a
 * subscription plan debits, in base units, read from the mint's terms once
 * when the mandate is made and stored with the row (`RecurringMandate`).
 *
 * - Debit-only: the subscriptions program pulls with a plain `TransferChecked`
 *   through CPI, and its plan cap counts the debit.
 * - The fee tolerance (`maxFeePerPull`) is the fee a pull of the debit may pay
 *   when the mandate is made (`recurringPullFee`). Before each pull the terms
 *   are read again; above the tolerance, the pull is held.
 * - Every build and verification uses the stored base units. A row written
 *   before mandates has none: its amount is parsed at the decimals of the
 *   read in hand, and its tolerance is that read's fee, as before.
 */

import { AmountError } from "@sdp/solana/amount";
import { isSameAsset } from "@sdp/solana/asset-ref";
import {
  type BaseUnits,
  parseTokenAmount,
  toBaseUnits,
  toTokenAmount,
} from "@sdp/solana/token-amount";
import {
  type DestinationTokenAccount,
  recurringPullFee,
  support,
  TOKEN_MOVEMENT_REFUSALS,
} from "@sdp/solana/token-movement";
import type { MintTokenTerms } from "@sdp/solana/token-terms";
import type { TokenMovementExpectation } from "@sdp/types/token-movements";
import { SPL_TOKEN_PROGRAMS } from "@sdp/types/well-known-tokens";
import { type Address, address } from "@solana/kit";
import type { RecurringMandate } from "@/db/repositories/recurring-mandate";
import { badRequest } from "@/lib/errors";
import { resolvePaymentAsset } from "@/services/payment-operation.service";
import {
  type MintMovementAccounts,
  readMintMovementAccountAt,
  readMintMovementAccounts,
} from "@/services/token-movement/read-terms";

/** A row a mandate belongs to: its token, its amount text and its stored mandate. */
export interface MandateRow {
  token: string;
  amount: string;
  mandate: RecurringMandate | null;
}

/**
 * Reads the terms of a recurring token's mint, with the token accounts of
 * `owners` in the same request.
 *
 * RPC budget: one `getMultipleAccounts` (mint, Clock and the owners' token
 * accounts).
 *
 * @param mandate - The row's stored mandate, whose asset names the program;
 *   null to resolve `token` as Payments resolves it.
 * @throws AppError (400) when the token is not a mint SDP can move.
 */
export async function readRecurringTerms(
  token: string,
  mandate: RecurringMandate | null,
  owners: readonly Address[]
): Promise<MintMovementAccounts> {
  const asset = mandate === null ? resolvePaymentAsset(token) : mandate.asset;
  if (asset.kind === "native") {
    throw badRequest("Recurring payments move SPL tokens only");
  }
  return readMintMovementAccounts(asset, owners);
}

/**
 * The terms and the token account a new pull of a plan will pay, as the caller
 * names that account (see {@link readMintMovementAccountAt}).
 *
 * @throws AppError (400) when the token is native SOL.
 */
export async function readRecurringReceiver(
  token: string,
  mandate: RecurringMandate | null,
  receiverTokenAccount: Address
): Promise<{ terms: MintTokenTerms; receiver: DestinationTokenAccount }> {
  const asset = mandate === null ? resolvePaymentAsset(token) : mandate.asset;
  if (asset.kind === "native") {
    throw badRequest("Recurring payments move SPL tokens only");
  }
  return readMintMovementAccountAt(asset, receiverTokenAccount);
}

/**
 * Makes a mandate from a request's amount under the terms read now: the debit
 * at the mint's decimals, and the fee tolerance a pull of it may pay now.
 *
 * @throws AppError (400) when the recurring row refuses the mint (a
 *   non-transferable or frozen-by-default mint; a paused mint is allowed, its
 *   pulls are held), the amount has more decimals than the mint or is not
 *   positive, or the fee would take the whole debit.
 */
export function createRecurringMandate(terms: MintTokenTerms, amount: string): RecurringMandate {
  const decision = support(terms, "recurring");
  if (!decision.supported && decision.disposition === "refuse") {
    throw badRequest(decision.message, { reason: decision.refusal });
  }
  let debit: BaseUnits;
  try {
    debit = toBaseUnits(parseTokenAmount(amount, terms.decimals));
  } catch (error) {
    if (error instanceof AmountError) {
      throw badRequest(error.message);
    }
    throw error;
  }
  if (debit === 0n) {
    throw badRequest("Subscription amount must be greater than zero");
  }
  const maxFeePerPull = recurringPullFee(terms, debit);
  if (maxFeePerPull >= debit) {
    throw badRequest(
      "The transfer fee takes the whole amount: the destination would receive nothing",
      {
        reason: TOKEN_MOVEMENT_REFUSALS.nothingCredited,
      }
    );
  }
  return { asset: terms.asset, decimals: terms.decimals, debit, maxFeePerPull };
}

/**
 * The mandate a row's pull or build uses under `terms`: the stored one, or,
 * for a row written before mandates, one made from its amount under `terms`.
 *
 * @throws AppError (400) when the stored mandate's mint changed since it was
 *   made (another program or other decimals): its base units no longer mean
 *   what was agreed.
 */
export function rowMandate(row: MandateRow, terms: MintTokenTerms): RecurringMandate {
  if (row.mandate === null) {
    return createRecurringMandate(terms, row.amount);
  }
  if (!isSameAsset(row.mandate.asset, terms.asset) || row.mandate.decimals !== terms.decimals) {
    throw badRequest(
      "This token's mint changed since the recurring payment was created; update the recurring payment"
    );
  }
  return row.mandate;
}

/**
 * Refuses activating a mandate the recurring path cannot pull: a mint the
 * recurring row refuses, or a destination that requires memos (the
 * subscriptions program's CPI cannot put a memo first).
 *
 * @throws AppError (400) with the refusal's `reason`.
 */
export function assertMandateActivatable(
  terms: MintTokenTerms,
  destination: DestinationTokenAccount
): void {
  const decision = support(terms, "recurring");
  if (!decision.supported && decision.disposition === "refuse") {
    throw badRequest(decision.message, { reason: decision.refusal });
  }
  if (destination.requiresMemo) {
    throw badRequest(
      `The destination token account ${destination.tokenAccount} requires a memo on incoming transfers, which a recurring pull cannot send`,
      { reason: TOKEN_MOVEMENT_REFUSALS.memoRequired }
    );
  }
}

/** The mint and token program a mandate's instructions name. */
export function mandateProgramAccounts(mandate: RecurringMandate): {
  mint: Address;
  tokenProgram: Address;
} {
  return {
    mint: mandate.asset.mint,
    tokenProgram: address(SPL_TOKEN_PROGRAMS[mandate.asset.program]),
  };
}

/** A mandate as the API reports it. */
export function mandateAmounts(mandate: RecurringMandate): TokenMovementExpectation {
  return {
    basis: "debit",
    debit: toTokenAmount(mandate.debit, mandate.decimals).value,
    decimals: mandate.decimals,
    maxFeePerPull: toTokenAmount(mandate.maxFeePerPull, mandate.decimals).value,
  };
}
