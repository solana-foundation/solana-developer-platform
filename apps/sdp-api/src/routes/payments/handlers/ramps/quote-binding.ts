import { compareDecimalAmounts } from "@sdp/payments/decimal";
import type { PaymentRampQuote } from "@sdp/types";
import type { PaymentTransferRow } from "@/db/repositories/payments.repository";
import { conflict } from "@/lib/errors";

/**
 * The full set of inputs a ramp provider reference (quote/session id) is bound
 * to when its transfer row is created. Reusing the reference with any of these
 * changed fails closed.
 */
export interface RampQuoteBinding {
  organizationId: string;
  projectId: string;
  walletId: string;
  counterpartyId: string;
  direction: "onramp" | "offramp";
  token: string;
  sourceAddress: string | null;
  destinationAddress: string | null;
  amount: string | null;
  fiatCurrency: string | null;
  fiatAmount: string | null;
}

function decimalFieldsDiffer(existing: string | null, expected: string | null): boolean {
  if (existing === null || expected === null) {
    return existing !== expected;
  }
  return compareDecimalAmounts(existing, expected) !== 0;
}

/**
 * Fails closed when a transfer already bound to this provider reference does
 * not match the current request: same reference + different tenant, project,
 * wallet, counterparty, direction, rail, or amounts is a reuse attempt, never
 * an idempotent replay.
 */
export function assertRampQuoteBindingMatches(
  existing: PaymentTransferRow,
  expected: RampQuoteBinding
): void {
  const matches =
    existing.organization_id === expected.organizationId &&
    existing.project_id === expected.projectId &&
    existing.wallet_id === expected.walletId &&
    existing.counterparty_id === expected.counterpartyId &&
    existing.type === expected.direction &&
    existing.token === expected.token &&
    existing.source_address === expected.sourceAddress &&
    existing.destination_address === expected.destinationAddress &&
    existing.fiat_currency === expected.fiatCurrency &&
    !decimalFieldsDiffer(existing.amount, expected.amount) &&
    !decimalFieldsDiffer(existing.fiat_amount, expected.fiatAmount);
  if (!matches) {
    throw conflict(
      "Provider quote/session reference is already bound to a different ramp transfer."
    );
  }
}

/**
 * Provider-data payload carrying the quote/session expiry the reference is
 * bound to. Providers without a reported expiry contribute nothing.
 */
export function rampQuoteExpiryProviderData(quote: PaymentRampQuote): Record<string, unknown> {
  const expiresAt =
    (quote.provider === "lightspark" || quote.provider === "moneygram") && quote.expiresAt
      ? quote.expiresAt
      : undefined;
  return expiresAt ? { rampQuote: { expiresAt } } : {};
}

/** Reads the bound quote/session expiry recorded at quote creation, if any. */
export function readRampQuoteExpiry(transfer: PaymentTransferRow): string | null {
  const rampQuote = transfer.provider_data.rampQuote;
  if (!rampQuote || typeof rampQuote !== "object" || Array.isArray(rampQuote)) {
    return null;
  }
  const expiresAt = (rampQuote as Record<string, unknown>).expiresAt;
  return typeof expiresAt === "string" && expiresAt.trim() ? expiresAt : null;
}

/** True when the transfer's bound quote/session expiry has passed. */
export function isRampQuoteBindingExpired(
  transfer: PaymentTransferRow,
  now: number = Date.now()
): boolean {
  const expiresAt = readRampQuoteExpiry(transfer);
  if (!expiresAt) {
    return false;
  }
  const expiryMs = Date.parse(expiresAt);
  return Number.isFinite(expiryMs) && expiryMs <= now;
}
