import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import { buildStripeCustomerInfo } from "@sdp/payments/ramps/providers/stripe/counterparty";
import type { CountryCode, PaymentRampQuote } from "@sdp/types";
import type { RampFiatCurrency } from "@sdp/types/generated/ramp-support";
import type { CollectedFieldData } from "@sdp/types/ramp-requirements";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import { type AppContext, rampRuntime } from "../../context";

export interface StripeOnrampQuoteArgs {
  counterparty: CounterpartyRow;
  destinationWalletAddress: string;
  country: CountryCode;
  collectedData?: CollectedFieldData;
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
    country: args.country,
    externalCustomerId: args.counterparty.external_id ?? args.counterparty.id,
    customerIpAddress: args.customerIpAddress,
    stripeCustomerInfo: buildStripeCustomerInfo(
      args.counterparty,
      args.country,
      args.collectedData
    ),
  });
}
