import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import type { StripeCustomerInfo } from "@sdp/payments/ramps/providers/stripe/client";
import type { PaymentRampQuote } from "@sdp/types";
import type { RampFiatCurrency } from "@sdp/types/generated/ramp-support";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import { type AppContext, rampRuntime } from "../../context";

function parseDob(value: string): StripeCustomerInfo["dob"] {
  const parts = value.split("-");
  if (parts.length !== 3) {
    return undefined;
  }
  const [yearPart, monthPart, dayPart] = parts;
  if (!yearPart || !monthPart || !dayPart) {
    return undefined;
  }
  const year = Number.parseInt(yearPart, 10);
  const month = Number.parseInt(monthPart, 10);
  const day = Number.parseInt(dayPart, 10);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return undefined;
  }
  return { year, month, day };
}

function bareSubdivision(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const index = value.lastIndexOf("-");
  return index === -1 ? value : value.slice(index + 1);
}

function buildStripeAddress(
  address: CounterpartyRow["identity"]["address"]
): StripeCustomerInfo["address"] {
  return {
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    state: bareSubdivision(address.subdivisionCode),
    postalCode: address.postalCode,
    country: address.countryCode,
  };
}

export function buildStripeCustomerInfo(counterparty: CounterpartyRow): StripeCustomerInfo {
  const info: StripeCustomerInfo = {
    email: counterparty.email,
    address: buildStripeAddress(counterparty.identity.address),
  };

  if (counterparty.entity_type === "individual") {
    info.firstName = counterparty.identity.firstName;
    info.lastName = counterparty.identity.lastName;
    info.dob = parseDob(counterparty.identity.dateOfBirth);
  }

  return info;
}

export interface StripeOnrampQuoteArgs {
  counterparty: CounterpartyRow;
  destinationWalletAddress: string;
  cryptoToken: string;
  fiatCurrency?: RampFiatCurrency;
  fiatAmount: string;
  customerIpAddress?: string;
}

export async function stripeOnrampQuote(
  c: AppContext,
  args: StripeOnrampQuoteArgs
): Promise<PaymentRampQuote> {
  return RAMP_PROVIDER_CLIENTS.stripe.createOnrampQuote(rampRuntime(c), {
    cryptoToken: args.cryptoToken,
    fiatCurrency: args.fiatCurrency,
    fiatAmount: args.fiatAmount,
    destinationWalletAddress: args.destinationWalletAddress,
    externalCustomerId: args.counterparty.external_id ?? args.counterparty.id,
    customerIpAddress: args.customerIpAddress,
    stripeCustomerInfo: buildStripeCustomerInfo(args.counterparty),
  });
}
