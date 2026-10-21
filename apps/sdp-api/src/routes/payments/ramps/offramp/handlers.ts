import { rampAmountLimitOf } from "@sdp/payments/errors";
import { rampClientFor } from "@sdp/payments/ramps";
import { OFFRAMP_SUPPORT, RAMP_SUPPORT_HASH } from "@sdp/types/generated/ramp";
import type { PaymentRampQuote } from "@sdp/types/payments";
import type { RampProviderId } from "@sdp/types/provider-access";
import { z } from "zod";
import { generatePaymentTransferId } from "@/db/repositories/payments.repository";
import { badRequest, badRequestQuery, internalError } from "@/lib/errors";
import { success } from "@/lib/response";
import { getRequestGateContext, type RequestGateExtraction } from "@/middleware/request-gate";
import { assertRampProviderInChannel } from "@/middleware/require-module";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { type AppContext, getPaymentsRepository, rampRuntime } from "@/routes/payments/context";
import {
  buildProviderDetails,
  type CreateOfframpQuoteBody,
  estimateAcrossProviders,
  filterProviders,
  persistRampQuoteTransfer,
  providersFromPairs,
  type RampQuoteResolved,
  resolveRampQuoteRequest,
  uniqueSorted,
} from "@/routes/payments/ramps/shared";
import { rampTransferTokenMint } from "@/services/payment-operation.service";
import { auditedRampWrite } from "@/services/payments/ramp-audit";

import {
  type createOfframpQuoteSchema,
  type estimateOfframpSchema,
  listOfframpCurrenciesQuerySchema,
} from "./schemas";
import { assertOfframpSourceFunded } from "./source-funds";

type OfframpCurrencyPair = {
  source: (typeof OFFRAMP_SUPPORT)[number]["source"];
  dest: (typeof OFFRAMP_SUPPORT)[number]["dest"];
  providers: RampProviderId[];
};

/**
 * Parse and resolve an off-ramp quote for the request gate.
 *
 * @param c - Request context.
 * @returns The validated body and resolved resources.
 */
export async function extractOfframpQuoteRequest(
  c: ValidatedBodyContext<typeof createOfframpQuoteSchema>
): Promise<RequestGateExtraction> {
  const input = c.req.valid("json");
  const { scope, projectId, counterparty, wallet, walletAddress } = await resolveRampQuoteRequest(
    c,
    "offramp",
    input,
    input.sourceCustodyWalletId
  );

  return { body: input, resolved: { scope, projectId, counterparty, wallet, walletAddress } };
}

export async function estimateOfframp(c: ValidatedBodyContext<typeof estimateOfframpSchema>) {
  const input = c.req.valid("json");
  const row = OFFRAMP_SUPPORT.find(
    (pair) => pair.source === input.assetRail && pair.dest === input.fiatCurrency
  );
  const providers = row ? filterProviders(c, row.providers) : [];

  const estimates = await estimateAcrossProviders(c, "offramp", providers, (client, ctx) =>
    client.estimateOfframp(ctx, {
      assetRail: input.assetRail,
      fiatCurrency: input.fiatCurrency,
      cryptoAmount: input.cryptoAmount,
    })
  );

  return success(c, { estimates });
}

export async function createOfframpQuote(c: AppContext): Promise<Response> {
  const {
    body: input,
    resolved: {
      scope,
      projectId,
      counterparty,
      wallet: sourceWallet,
      walletAddress: sourceWalletAddress,
    },
  } = getRequestGateContext<CreateOfframpQuoteBody, RampQuoteResolved>(c);

  // Requirements have succeeded. Reserve the ID now so the provider
  // quote and the eventual transfer row share the same internal transfer ID.
  const reservedTransferId = generatePaymentTransferId();
  let quote: PaymentRampQuote;
  let precreatedTransferId: string | undefined;
  switch (input.provider) {
    case "moonpay": {
      const moonpay = rampClientFor("moonpay", "offramp");
      const runtime = rampRuntime(c, "moonpay");
      const fiatCurrency = input.fiatCurrency ?? "USD";
      const token = rampTransferTokenMint(input.assetRail);
      // One provider estimate and one balance read, side by side, before any
      // row: the estimate is the payout SDP quotes and refuses an amount
      // MoonPay would not take; the read refuses a sale the wallet cannot fund.
      const [estimated, funded] = await Promise.allSettled([
        moonpay.estimateOfframp(runtime, {
          assetRail: input.assetRail,
          fiatCurrency,
          cryptoAmount: input.cryptoAmount,
        }),
        assertOfframpSourceFunded(sourceWalletAddress, token, input.cryptoAmount),
      ]);
      if (estimated.status === "rejected" && rampAmountLimitOf(estimated.reason) !== null) {
        throw estimated.reason;
      }
      if (funded.status === "rejected") throw funded.reason;
      if (estimated.status === "rejected") throw estimated.reason;
      const apiKey = c.get("apiKey");
      const pendingMoonpayTransfer = await getPaymentsRepository(c).createTransfer({
        id: reservedTransferId,
        organizationId: scope.auth.organizationId,
        projectId,
        custodyWalletId: sourceWallet.id,
        walletId: sourceWallet.walletId,
        counterpartyId: counterparty.id,
        sourceAddress: sourceWalletAddress,
        destinationAddress: null,
        token,
        amount: input.cryptoAmount,
        memo: null,
        type: "offramp",
        direction: "outbound",
        status: "pending",
        provider: "moonpay",
        providerReference: null,
        deliveryMode: null,
        fiatCurrency,
        fiatAmount: estimated.value.fiatAmount,
        rampsMemo: input.rampsMemo,
        providerData: {},
        serializedTx: null,
        signature: null,
        slot: null,
        initiatedByKeyId: apiKey ? apiKey.id : null,
      });
      if (!pendingMoonpayTransfer) {
        throw internalError("Failed to create MoonPay off-ramp transfer record");
      }
      precreatedTransferId = pendingMoonpayTransfer.id;
      try {
        quote = await moonpay.createOfframpQuote(runtime, {
          assetRail: input.assetRail,
          fiatCurrency,
          cryptoAmount: input.cryptoAmount,
          sourceWalletAddress,
          externalCustomerId: counterparty.id,
          paymentTransferId: pendingMoonpayTransfer.id,
        });
        const updated = await auditedRampWrite(c, "create", (repository) =>
          repository.transitionRampTransfer({
            transferId: pendingMoonpayTransfer.id,
            organizationId: scope.auth.organizationId,
            projectId,
            transition: "quote_issued",
            deliveryMode: quote.deliveryMode,
            updatedAt: new Date().toISOString(),
          })
        );
        if (!updated) {
          throw internalError("Failed to complete MoonPay off-ramp transfer record");
        }
      } catch (error) {
        await getPaymentsRepository(c).transitionRampTransfer({
          transferId: pendingMoonpayTransfer.id,
          organizationId: scope.auth.organizationId,
          projectId,
          transition: "quote_failed",
          error: error instanceof Error ? error.message : String(error),
          updatedAt: new Date().toISOString(),
        });
        throw error;
      }
      break;
    }
    case "stripe":
      throw badRequest("Stripe off-ramp is not supported.");
    default: {
      const exhaustive: never = input.provider;
      throw internalError(`Off-ramp quote provider is not implemented: ${String(exhaustive)}`);
    }
  }

  let transferId: string;
  if (precreatedTransferId) {
    transferId = precreatedTransferId;
  } else {
    transferId = await persistRampQuoteTransfer(c, {
      transferId: reservedTransferId,
      scope,
      projectId,
      counterparty,
      quote,
      direction: "offramp",
      wallet: sourceWallet,
      walletAddress: sourceWalletAddress,
      assetRail: input.assetRail,
      cryptoAmount: input.cryptoAmount,
      fiatCurrency: input.fiatCurrency ? input.fiatCurrency : null,
      fiatAmount: null,
      rampsMemo: input.rampsMemo,
    });
  }

  return success(c, { quote, transferId });
}

export async function listOfframpCurrencies(c: AppContext) {
  const parsed = listOfframpCurrenciesQuerySchema.safeParse(c.req.query());

  if (!parsed.success) {
    throw badRequestQuery({
      errors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  const { source, dest, provider } = parsed.data;
  if (provider) {
    assertRampProviderInChannel(c, provider);
  }
  const pairs: OfframpCurrencyPair[] = OFFRAMP_SUPPORT.flatMap((row) => {
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
    providerDetails: buildProviderDetails(providersFromPairs(pairs), "offramp"),
    supportHash: RAMP_SUPPORT_HASH,
  });
}
