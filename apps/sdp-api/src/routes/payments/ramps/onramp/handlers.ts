import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import { ONRAMP_SUPPORT, RAMP_SUPPORT_HASH } from "@sdp/types/generated/ramp";
import type { PaymentRampQuote } from "@sdp/types/payments";
import type { RampProviderId } from "@sdp/types/provider-access";
import { z } from "zod";
import { generatePaymentTransferId } from "@/db/repositories/payments.repository";
import { getClientIp } from "@/lib/client-ip";
import { AppError, badRequestQuery, internalError } from "@/lib/errors";
import { success } from "@/lib/response";
import { getRequestGateContext, type RequestGateExtraction } from "@/middleware/request-gate";
import { assertRampProviderInChannel } from "@/middleware/require-module";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { type AppContext, getPaymentsRepository, rampRuntime } from "@/routes/payments/context";
import {
  buildProviderDetails,
  type CreateOnrampQuoteBody,
  estimateAcrossProviders,
  filterProviders,
  persistRampQuoteTransfer,
  providersFromPairs,
  type RampQuoteResolved,
  rampQuoteTransferStatus,
  resolveRampQuoteRequest,
  uniqueSorted,
} from "@/routes/payments/ramps/shared";
import { rampTransferTokenMint } from "@/services/payment-operation.service";
import {
  type createOnrampQuoteSchema,
  type estimateOnrampSchema,
  listOnrampCurrenciesQuerySchema,
} from "./schemas";

type OnrampCurrencyPair = {
  source: (typeof ONRAMP_SUPPORT)[number]["source"];
  dest: (typeof ONRAMP_SUPPORT)[number]["dest"];
  providers: RampProviderId[];
};

/**
 * Parse and resolve an on-ramp quote for the request gate.
 *
 * @param c - Request context.
 * @returns The validated body and resolved resources.
 */
export async function extractOnrampQuoteRequest(
  c: ValidatedBodyContext<typeof createOnrampQuoteSchema>
): Promise<RequestGateExtraction> {
  const input = c.req.valid("json");
  const { scope, projectId, counterparty, wallet, walletAddress } = await resolveRampQuoteRequest(
    c,
    "onramp",
    input,
    input.destinationCustodyWalletId
  );

  return { body: input, resolved: { scope, projectId, counterparty, wallet, walletAddress } };
}

export async function estimateOnramp(c: ValidatedBodyContext<typeof estimateOnrampSchema>) {
  const input = c.req.valid("json");
  const row = ONRAMP_SUPPORT.find(
    (pair) => pair.source === input.fiatCurrency && pair.dest === input.assetRail
  );
  const providers = row ? filterProviders(c, row.providers) : [];

  const estimates = await estimateAcrossProviders(c, providers, (provider, ctx) =>
    RAMP_PROVIDER_CLIENTS[provider].estimateOnramp(ctx, {
      assetRail: input.assetRail,
      fiatCurrency: input.fiatCurrency,
      fiatAmount: input.fiatAmount,
    })
  );

  return success(c, { estimates });
}

export async function createOnrampQuote(c: AppContext): Promise<Response> {
  const {
    body: input,
    resolved: {
      scope,
      projectId,
      counterparty,
      wallet: destinationWallet,
      walletAddress: destinationWalletAddress,
    },
  } = getRequestGateContext<CreateOnrampQuoteBody, RampQuoteResolved>(c);

  // Requirements have succeeded. Reserve the ID now so the provider
  // quote and the eventual transfer row share the same internal transfer ID.
  const reservedTransferId = generatePaymentTransferId();
  let quote: PaymentRampQuote;
  let precreatedTransferId: string | undefined;
  switch (input.provider) {
    case "moonpay": {
      const apiKey = c.get("apiKey");
      const pendingTransfer = await getPaymentsRepository(c).createTransfer({
        id: reservedTransferId,
        organizationId: scope.auth.organizationId,
        projectId,
        custodyWalletId: destinationWallet.id,
        walletId: destinationWallet.walletId,
        counterpartyId: counterparty.id,
        sourceAddress: null,
        destinationAddress: destinationWalletAddress,
        token: rampTransferTokenMint(input.assetRail),
        amount: null,
        memo: null,
        type: "onramp",
        direction: "inbound",
        status: "pending",
        provider: "moonpay",
        providerReference: null,
        deliveryMode: null,
        fiatCurrency: input.fiatCurrency,
        fiatAmount: input.fiatAmount,
        rampsMemo: input.rampsMemo,
        providerData: {},
        serializedTx: null,
        signature: null,
        slot: null,
        initiatedByKeyId: apiKey ? apiKey.id : null,
      });
      if (!pendingTransfer) {
        throw internalError("Failed to create MoonPay on-ramp transfer record");
      }
      precreatedTransferId = pendingTransfer.id;
      try {
        quote = await RAMP_PROVIDER_CLIENTS.moonpay.createOnrampQuote(rampRuntime(c), {
          assetRail: input.assetRail,
          fiatCurrency: input.fiatCurrency,
          fiatAmount: input.fiatAmount,
          destinationWalletAddress,
          externalCustomerId: counterparty.id,
          paymentTransferId: pendingTransfer.id,
        });
        const updated = await getPaymentsRepository(c).updateTransfer({
          transferId: pendingTransfer.id,
          organizationId: scope.auth.organizationId,
          projectId,
          status: rampQuoteTransferStatus(quote),
          deliveryMode: quote.deliveryMode,
          updatedAt: new Date().toISOString(),
        });
        if (!updated) {
          throw internalError("Failed to complete MoonPay on-ramp transfer record");
        }
      } catch (error) {
        await getPaymentsRepository(c).updateTransfer({
          transferId: pendingTransfer.id,
          organizationId: scope.auth.organizationId,
          projectId,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
          updatedAt: new Date().toISOString(),
        });
        throw error;
      }
      break;
    }
    case "stripe": {
      quote = await RAMP_PROVIDER_CLIENTS.stripe.createOnrampQuote(rampRuntime(c), {
        assetRail: input.assetRail,
        fiatCurrency: input.fiatCurrency,
        fiatAmount: input.fiatAmount,
        destinationWalletAddress,
        externalCustomerId: counterparty.id,
        customerIpAddress: getClientIp(c) ?? undefined,
      });
      break;
    }
    default: {
      const exhaustive: never = input.provider;
      throw new AppError(
        "INTERNAL_ERROR",
        `On-ramp quotes are not implemented for provider: ${String(exhaustive)}`
      );
    }
  }

  const transferId = precreatedTransferId
    ? precreatedTransferId
    : await persistRampQuoteTransfer(c, {
        transferId: reservedTransferId,
        scope,
        projectId,
        counterparty,
        quote,
        direction: "onramp",
        wallet: destinationWallet,
        walletAddress: destinationWalletAddress,
        assetRail: input.assetRail,
        cryptoAmount: null,
        fiatCurrency: input.fiatCurrency ? input.fiatCurrency : null,
        fiatAmount: input.fiatAmount,
        rampsMemo: input.rampsMemo,
      });

  return success(c, { quote, transferId });
}

export async function listOnrampCurrencies(c: AppContext) {
  const parsed = listOnrampCurrenciesQuerySchema.safeParse(c.req.query());

  if (!parsed.success) {
    throw badRequestQuery({
      errors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  const { source, dest, provider } = parsed.data;
  if (provider) {
    assertRampProviderInChannel(c, provider);
  }
  const pairs: OnrampCurrencyPair[] = ONRAMP_SUPPORT.flatMap((row) => {
    if (source && row.source !== source) return [];
    if (dest && row.dest !== dest) return [];
    const providers = filterProviders(c, row.providers, provider);
    if (providers.length === 0) return [];
    return [{ source: row.source, dest: row.dest, providers }];
  });

  return success(c, {
    currencies: {
      sources: uniqueSorted(pairs.map((row) => row.source)),
      destinations: uniqueSorted(pairs.map((row) => row.dest)),
    },
    pairs,
    providerDetails: buildProviderDetails(providersFromPairs(pairs), "onramp"),
    supportHash: RAMP_SUPPORT_HASH,
  });
}
