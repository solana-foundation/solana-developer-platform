/**
 * A mint's Token Terms and a movement quote under them (ADR 0012), read-only.
 *
 * Both routes read the mint and the Clock live in one `getMultipleAccounts`
 * request (`readMintMovementAccounts` with no destination) and build nothing.
 * The terms say what a movement of the token does on each path; the quote
 * prices one amount, and converts a display amount (what a scaled or
 * interest-bearing mint's wallets show) to the token amount a request sends.
 */

import { currentClusterScope } from "@sdp/rpc/scope";
import { AmountError } from "@sdp/solana/amount";
import { AssetResolutionError, resolveAssetRequest } from "@sdp/solana/asset-ref";
import { type MovementQuote, quoteMovement } from "@sdp/solana/movement-quote";
import {
  type BaseUnits,
  parseTokenAmount,
  type TokenAmount,
  toTokenAmount,
} from "@sdp/solana/token-amount";
import { capabilityRefusals } from "@sdp/solana/token-movement";
import {
  type DisplayRounding,
  type DisplayRule,
  epochFee,
  fromDisplay,
  type MintTokenTerms,
  type TransferFeeRate,
} from "@sdp/solana/token-terms";
import {
  TOKEN_MOVEMENT_PATH_MODULES,
  TOKEN_MOVEMENT_PATHS,
  type TokenAmountQuote,
  type TokenDisplayTerms,
  type TokenMovementAmounts,
  type TokenMovementBasis,
  type TokenMovementPath,
  type TokenTermsSummary,
  type TokenTransferFeeEntry,
} from "@sdp/types/token-movements";
import type { Context } from "hono";
import { badRequest } from "@/lib/errors";
import { success } from "@/lib/response";
import { isModuleInChannel } from "@/middleware/require-module";
import type { ValidatedContext } from "@/middleware/validate";
import { EARN_PUBLIC_SURFACE_PUBLISHED } from "@/openapi/spec";
import { chainTimeIso } from "@/services/token-movement/chain-time";
import { readMintMovementAccounts } from "@/services/token-movement/read-terms";
import type { Env } from "@/types/env";
import type { quoteTokenAmountSchema, tokenMintParamsSchema } from "./schemas";

/** How long a quote is good for, at most: an interest-bearing mint's display moves every second. */
const QUOTE_TTL_SECONDS = 60n;

/**
 * The live terms of the mint in the path, on the open cluster scope.
 *
 * @throws AppError (400) when the address is a catalogue mint of another
 * cluster, holds no account, or is not a mint SDP can read.
 */
async function readTermsOfMint(mint: string): Promise<MintTokenTerms> {
  let asset: ReturnType<typeof resolveAssetRequest>;
  try {
    asset = resolveAssetRequest(mint, currentClusterScope().cluster);
  } catch (error) {
    if (error instanceof AssetResolutionError) {
      throw badRequest(error.message, { reason: error.reason });
    }
    throw error;
  }
  if (asset.kind === "native") {
    throw badRequest("Native SOL has no mint terms");
  }
  return (await readMintMovementAccounts(asset, [])).terms;
}

function feeEntry(rate: TransferFeeRate, decimals: number): TokenTransferFeeEntry {
  return {
    epoch: rate.epoch.toString(),
    basisPoints: rate.basisPoints,
    maximumFee: toTokenAmount(rate.maximumFee, decimals).value,
  };
}

/** Unix seconds of 0000-01-01T00:00:00Z and 9999-12-31T23:59:59Z: the times ISO 8601's four-digit year shows. */
const FIRST_ISO_SECOND = -62_167_219_200n;
const LAST_ISO_SECOND = 253_402_300_799n;

/**
 * A time the mint's issuer set, as ISO 8601. Token-2022 stores any i64
 * there, and a time outside the four-digit years has no ISO 8601 date.
 *
 * @throws AppError (400) when the time is outside those years.
 */
function issuerTimeIso(unixTimestamp: bigint): string {
  if (unixTimestamp < FIRST_ISO_SECOND || unixTimestamp > LAST_ISO_SECOND) {
    throw badRequest("The mint's display terms name a time too far from now to show as a date");
  }
  return chainTimeIso(unixTimestamp);
}

function displayTerms(rule: DisplayRule): TokenDisplayTerms {
  switch (rule.kind) {
    case "plain":
      return { rule: "plain" };
    case "scaled":
      return {
        rule: "scaled",
        multiplier: rule.multiplier,
        newMultiplier: rule.newMultiplier,
        newMultiplierEffectiveAt: issuerTimeIso(rule.newMultiplierEffectiveAt),
      };
    case "interest":
      return {
        rule: "interest",
        currentRate: rule.currentRate,
        preUpdateAverageRate: rule.preUpdateAverageRate,
        initializedAt: issuerTimeIso(rule.initializedAt),
        lastUpdateAt: issuerTimeIso(rule.lastUpdateAt),
      };
    default: {
      const exhaustive: never = rule;
      throw new Error(`Unknown display rule: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * The movement paths this deployment runs: a path's module must be in the
 * release channel, and Earn's must also be published (PRO-2038), so the
 * response names only what the deployment's public document does.
 */
function servedPaths(c: Context<{ Bindings: Env }>): TokenMovementPath[] {
  return TOKEN_MOVEMENT_PATHS.filter((path) => {
    const module = TOKEN_MOVEMENT_PATH_MODULES[path];
    if (module === "earn" && !EARN_PUBLIC_SURFACE_PUBLISHED) {
      return false;
    }
    return isModuleInChannel(c, module);
  });
}

/** The terms as the route reports them, with the capability decision of each path. */
export function summarizeTokenTerms(
  terms: MintTokenTerms,
  paths: readonly TokenMovementPath[]
): TokenTermsSummary {
  const { epoch } = terms.readAt;
  const current = epochFee(terms, epoch);
  const next = epochFee(terms, epoch + 1n);
  return {
    mint: terms.asset.mint,
    program: terms.asset.program,
    decimals: terms.decimals,
    readAt: {
      slot: terms.readAt.slot.toString(),
      epoch: epoch.toString(),
      time: chainTimeIso(terms.readAt.unixTimestamp),
    },
    transferFee:
      current === null || next === null
        ? null
        : { current: feeEntry(current, terms.decimals), next: feeEntry(next, terms.decimals) },
    display: displayTerms(terms.display),
    transferHookProgram: terms.transferHookProgram,
    paused: terms.paused,
    nonTransferable: terms.nonTransferable,
    defaultAccountState: terms.defaultAccountState,
    permanentDelegate: terms.permanentDelegate,
    confidentialTransfers: terms.confidentialTransfers,
    support: paths.map((path) => {
      const refusals = capabilityRefusals(terms, path).map((notice) => ({
        reason: notice.refusal,
        extension: notice.extension,
        disposition: notice.disposition,
        message: notice.message,
      }));
      return { path, supported: refusals.length === 0, refusals };
    }),
  };
}

/** GET /v1/tokens/:mint/terms */
export async function getTokenTerms(c: ValidatedContext<{ param: typeof tokenMintParamsSchema }>) {
  const { mint } = c.req.valid("param");
  const terms = await readTermsOfMint(mint);
  return success(c, { terms: summarizeTokenTerms(terms, servedPaths(c)) });
}

/**
 * Which base-unit amount a display input names when none shows it exactly.
 * A debit never takes more than the sender typed; a credit never gives the
 * recipient less.
 */
function displayRounding(basis: TokenMovementBasis): DisplayRounding {
  switch (basis) {
    case "debit":
      return "atMost";
    case "credit":
      return "atLeast";
    default: {
      const exhaustive: never = basis;
      throw new Error(`Unknown movement basis: ${String(exhaustive)}`);
    }
  }
}

/** The quote's amounts in token units, with display values for a scaled or interest-bearing mint. */
function quoteAmounts(quote: MovementQuote): TokenMovementAmounts {
  const units = (value: BaseUnits) => toTokenAmount(value, quote.decimals).value;
  const amounts: TokenMovementAmounts = {
    basis: quote.intent.basis,
    debit: units(quote.debit),
    fee: units(quote.fee),
    credit: units(quote.credit),
    decimals: quote.decimals,
  };
  if (quote.display !== null && quote.asOf !== null) {
    amounts.display = {
      debit: quote.display.debit.value,
      fee: quote.display.fee.value,
      credit: quote.display.credit.value,
      asOf: chainTimeIso(quote.asOf.unixTimestamp),
    };
  }
  return amounts;
}

/**
 * When the quote stops being good: a short time after the read, and never
 * after a pending multiplier switch, past which the same display amount is
 * another token amount.
 */
function quoteExpiry(terms: MintTokenTerms): bigint {
  const readAt = terms.readAt.unixTimestamp;
  const ttlEnd = readAt + QUOTE_TTL_SECONDS;
  if (terms.display.kind === "scaled") {
    const switchAt = terms.display.newMultiplierEffectiveAt;
    if (switchAt > readAt && switchAt < ttlEnd) {
      return switchAt;
    }
  }
  return ttlEnd;
}

/** POST /v1/tokens/:mint/quote */
export async function quoteTokenAmount(
  c: ValidatedContext<{ param: typeof tokenMintParamsSchema; json: typeof quoteTokenAmountSchema }>
) {
  const { mint } = c.req.valid("param");
  const body = c.req.valid("json");
  const terms = await readTermsOfMint(mint);
  const at = terms.readAt.unixTimestamp;

  let quote: MovementQuote;
  try {
    let amount: TokenAmount;
    switch (body.input) {
      case "token":
        amount = parseTokenAmount(body.amount, terms.decimals);
        break;
      case "display": {
        const units = fromDisplay(terms, body.displayAmount, at, displayRounding(body.basis));
        if (units === 0n) {
          throw badRequest("The display amount is less than the smallest amount of this token");
        }
        amount = toTokenAmount(units, terms.decimals);
        break;
      }
      default: {
        const exhaustive: never = body;
        throw new Error(`Unknown quote input: ${JSON.stringify(exhaustive)}`);
      }
    }
    quote = quoteMovement(terms, { asset: terms.asset, amount, basis: body.basis });
  } catch (error) {
    if (error instanceof AmountError) {
      throw badRequest(error.message);
    }
    throw error;
  }

  const response: TokenAmountQuote = {
    mint: terms.asset.mint,
    amount: quote.intent.amount.value,
    amounts: quoteAmounts(quote),
    feeEpoch: quote.feeEpoch === null ? null : quote.feeEpoch.toString(),
    asOf: chainTimeIso(at),
    expiresAt: chainTimeIso(quoteExpiry(terms)),
  };
  return success(c, { quote: response });
}
