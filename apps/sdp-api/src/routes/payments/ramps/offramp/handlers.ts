import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import {
  BVNK_FUNDING_WALLET_FIAT,
  bvnkPayoutPartyDetailsFromCustomer,
  isBvnkCustomerVerified,
} from "@sdp/payments/ramps/providers/bvnk/provider-data";
import { currentClusterScope } from "@sdp/rpc/scope";
import { BVNK_FUNDING_WALLET_STATUS, type PaymentRampQuote } from "@sdp/types";
import { OFFRAMP_SUPPORT, RAMP_SUPPORT_HASH } from "@sdp/types/generated/ramp";
import type { RampProviderId } from "@sdp/types/provider-access";
import { z } from "zod";
import { getDb } from "@/db";
import { createPostgresCounterpartyProviderAccountsRepository } from "@/db/repositories";
import { generatePaymentTransferId } from "@/db/repositories/payments.repository";
import {
  badRequest,
  badRequestQuery,
  counterpartyNotProvisioned,
  internalError,
} from "@/lib/errors";
import { success } from "@/lib/response";
import { getRequestGateContext, type RequestGateExtraction } from "@/middleware/request-gate";
import { assertRampProviderInChannel } from "@/middleware/require-module";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { rampTransferTokenMint } from "@/services/payment-operation.service";
import { type AppContext, getPaymentsRepository, rampRuntime } from "../../context";
import {
  completePendingBvnkOfframpTransfer,
  createPendingBvnkOfframpTransfer,
  readFundingWalletRow,
  refreshBvnkCustomerAccount,
} from "../providers/bvnk";
import {
  buildProviderDetails,
  type CreateOfframpQuoteBody,
  estimateAcrossProviders,
  filterProviders,
  persistRampQuoteTransfer,
  providersFromPairs,
  type RampQuoteResolved,
  rampQuoteTransferStatus,
  resolveRampQuoteRequest,
  uniqueSorted,
} from "../shared";

import {
  type createOfframpQuoteSchema,
  type estimateOfframpSchema,
  listOfframpCurrenciesQuerySchema,
} from "./schemas";

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

  const estimates = await estimateAcrossProviders(c, providers, (provider, ctx) =>
    RAMP_PROVIDER_CLIENTS[provider].estimateOfframp(ctx, {
      assetRail: input.assetRail,
      fiatCurrency: input.fiatCurrency,
      cryptoAmount: input.cryptoAmount,
    })
  );

  return success(c, { estimates });
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: provider dispatch keeps each off-ramp integration explicit, including its persistence and failure semantics.
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
        token: rampTransferTokenMint(input.assetRail, currentClusterScope().cluster),
        amount: input.cryptoAmount,
        memo: null,
        type: "offramp",
        direction: "outbound",
        status: "pending",
        provider: "moonpay",
        providerReference: null,
        deliveryMode: null,
        fiatCurrency: input.fiatCurrency ? input.fiatCurrency : null,
        fiatAmount: null,
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
        quote = await RAMP_PROVIDER_CLIENTS.moonpay.createOfframpQuote(rampRuntime(c), {
          assetRail: input.assetRail,
          fiatCurrency: input.fiatCurrency,
          cryptoAmount: input.cryptoAmount,
          sourceWalletAddress,
          externalCustomerId: counterparty.id,
          paymentTransferId: pendingMoonpayTransfer.id,
        });
        const updated = await getPaymentsRepository(c).updateTransfer({
          transferId: pendingMoonpayTransfer.id,
          organizationId: scope.auth.organizationId,
          projectId,
          status: rampQuoteTransferStatus(quote),
          deliveryMode: quote.deliveryMode,
          updatedAt: new Date().toISOString(),
        });
        if (!updated) {
          throw internalError("Failed to complete MoonPay off-ramp transfer record");
        }
      } catch (error) {
        await getPaymentsRepository(c).updateTransfer({
          transferId: pendingMoonpayTransfer.id,
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
    case "bvnk": {
      if (input.fiatCurrency !== BVNK_FUNDING_WALLET_FIAT) {
        throw badRequest("BVNK supports USD only.");
      }
      const accounts = createPostgresCounterpartyProviderAccountsRepository(getDb(c.env));
      const fundingRow = await readFundingWalletRow(
        accounts,
        {
          organizationId: scope.auth.organizationId,
          projectId,
          counterpartyId: counterparty.id,
          provider: "bvnk",
        },
        BVNK_FUNDING_WALLET_FIAT
      );
      if (
        fundingRow === null ||
        fundingRow.provider_status !== BVNK_FUNDING_WALLET_STATUS.provisioned ||
        fundingRow.external_account_reference === null
      ) {
        throw counterpartyNotProvisioned("bvnk", "offramp", {
          fundingWalletStatus: fundingRow === null ? null : fundingRow.provider_status,
        });
      }
      const customerLinkRow = await accounts.getProviderAccount({
        organizationId: scope.auth.organizationId,
        projectId,
        counterpartyId: counterparty.id,
        provider: "bvnk",
      });
      if (customerLinkRow === null) {
        throw counterpartyNotProvisioned("bvnk", "offramp");
      }
      const refreshedCustomer = await refreshBvnkCustomerAccount(c.env, rampRuntime(c), {
        counterparty,
        projectId,
        providerAccountId: customerLinkRow.id,
        customerReference: customerLinkRow.provider_customer_reference,
      });
      if (!isBvnkCustomerVerified(refreshedCustomer.customer.status)) {
        throw counterpartyNotProvisioned("bvnk", "offramp", {
          customerStatus: refreshedCustomer.customer.status,
        });
      }
      const customerReference = customerLinkRow.provider_customer_reference;
      const bvnkCustomer = refreshedCustomer.latest;
      const pendingTransfer = await createPendingBvnkOfframpTransfer(c, {
        transferId: reservedTransferId,
        organizationId: scope.auth.organizationId,
        projectId,
        counterpartyId: counterparty.id,
        custodyWalletId: sourceWallet.id,
        walletId: sourceWallet.walletId,
        walletAddress: sourceWalletAddress,
        assetRail: input.assetRail,
        cryptoAmount: input.cryptoAmount,
        fiatCurrency: input.fiatCurrency,
        rampsMemo: input.rampsMemo,
      });
      let bvnkQuote: PaymentRampQuote;
      try {
        bvnkQuote = await RAMP_PROVIDER_CLIENTS.bvnk.createOfframpQuote(rampRuntime(c), {
          assetRail: input.assetRail,
          fiatCurrency: input.fiatCurrency,
          cryptoAmount: input.cryptoAmount,
          sourceWalletAddress,
          paymentTransferId: pendingTransfer.id,
          externalCustomerId: customerReference,
          bvnkCompliance: {
            partyDetails: [bvnkPayoutPartyDetailsFromCustomer(bvnkCustomer, "ORIGINATOR")],
          },
          bvnkFundingWalletId: fundingRow.external_account_reference,
        });
      } catch (error) {
        await getPaymentsRepository(c).updateTransferStatusGuarded({
          transferId: pendingTransfer.id,
          organizationId: scope.auth.organizationId,
          projectId,
          fromStatuses: ["pending"],
          toStatus: "failed",
          error: error instanceof Error ? error.message : String(error),
          updatedAt: new Date().toISOString(),
        });
        throw error;
      }
      await completePendingBvnkOfframpTransfer(c, {
        organizationId: scope.auth.organizationId,
        projectId,
        transferId: pendingTransfer.id,
        quote: bvnkQuote,
        cryptoAmount: input.cryptoAmount,
        status: rampQuoteTransferStatus(bvnkQuote),
        channel: {
          walletId: fundingRow.external_account_reference,
          customerReference: customerReference,
        },
      });
      quote = bvnkQuote;
      precreatedTransferId = pendingTransfer.id;
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
