import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import type { PaymentRampQuote } from "@sdp/types";
import type { RampFiatCurrency } from "@sdp/types/generated/ramp";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import { type AppContext, rampRuntime } from "../../context";

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
    externalCustomerId: args.counterparty.id,
    customerIpAddress: args.customerIpAddress,
  });
}
