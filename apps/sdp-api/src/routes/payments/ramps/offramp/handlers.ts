import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import {
  BVNK_FUNDING_WALLET_FIAT,
  bvnkPayoutPartyDetailsFromCustomer,
  isBvnkCustomerVerified,
} from "@sdp/payments/ramps/providers/bvnk/provider-data";
import {
  isLightsparkExternalAccountActive,
  readLightsparkPurposeOfPayment,
} from "@sdp/payments/ramps/providers/lightspark/provider-data";
import { BVNK_FUNDING_WALLET_STATUS, type PaymentRampQuote } from "@sdp/types";
import { OFFRAMP_SUPPORT, RAMP_SUPPORT_HASH } from "@sdp/types/generated/ramp";
import type { RampProviderId } from "@sdp/types/provider-access";
import { z } from "zod";
import { getDb } from "@/db";
import { createPostgresCounterpartyProviderAccountsRepository } from "@/db/repositories";
import type { CounterpartyProviderAccountRow } from "@/db/repositories/counterparty-provider-account.repository";
import { generatePaymentTransferId } from "@/db/repositories/payments.repository";
import {
  badRequest,
  badRequestQuery,
  counterpartyNotProvisioned,
  internalError,
} from "@/lib/errors";
import { success } from "@/lib/response";
import { IDEMPOTENCY_KEY_HEADER } from "@/middleware/idempotency-key";
import { getPolicyGateContext, type PolicyGateExtraction } from "@/middleware/policy-gate";
import type { ValidatedBodyContext } from "@/middleware/validate";
import { rampTransferTokenMint } from "@/services/payment-operation.service";
import { beginApprovedWalletOperationEffect } from "@/services/policy/approved-operation-replay";
import { walletOperationActorFromAuth } from "@/services/policy/enforcement.service";
import {
  type AppContext,
  getPaymentsRepository,
  rampRuntime,
  resolveSdpEnvironment,
} from "../../context";
import {
  completePendingBvnkOfframpTransfer,
  createPendingBvnkOfframpTransfer,
  readFundingWalletRow,
  refreshBvnkCustomerAccount,
} from "../providers/bvnk";
import {
  lightsparkProviderCustomerId,
  requireLightsparkPayoutAccountById,
  selectLightsparkPayoutAccount,
} from "../providers/lightspark";
import {
  failReservedRampQuoteTransfer,
  type RampQuoteReservation,
  rampQuoteIdempotencyFingerprint,
  rampQuoteResponseProviderData,
  reserveKeyedRampQuoteTransfer,
} from "../quote-idempotency";
import {
  buildProviderDetails,
  type CreateOfframpQuoteBody,
  estimateAcrossProviders,
  filterProviders,
  persistRampQuoteTransfer,
  providersFromPairs,
  type RampQuotePolicyResolved,
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
 * Parse and resolve an off-ramp quote into its wallet-operation policy candidate.
 *
 * @param c - Request context.
 * @returns The candidate, validated body, resolved resources, and raw payload.
 */
export async function extractOfframpQuotePolicyCandidate(
  c: ValidatedBodyContext<typeof createOfframpQuoteSchema>
): Promise<PolicyGateExtraction> {
  const input = c.req.valid("json");
  const { scope, projectId, counterparty, wallet, walletAddress } = await resolveRampQuoteRequest(
    c,
    "offramp",
    input,
    input.sourceCustodyWalletId
  );

  return {
    candidate: {
      organizationId: scope.auth.organizationId,
      projectId: scope.auth.projectId,
      custodyWalletId: wallet.id,
      walletId: wallet.walletId,
      apiKeyId: scope.auth.apiKeyId,
      actor: walletOperationActorFromAuth(scope.auth),
      source: "api",
      operationFamily: "ramp",
      operationType: "ramp_offramp_quote",
      asset: rampTransferTokenMint(input.assetRail, c.env),
      amount: input.cryptoAmount,
      destination: null,
      context: {},
      providerExtensions: { provider: input.provider },
    },
    legs: [],
    body: input,
    resolved: { scope, projectId, counterparty, wallet, walletAddress },
    rawPayload: {
      provider: input.provider,
      counterpartyId: input.counterpartyId,
      fiatCurrency: input.fiatCurrency,
      cryptoAmount: input.cryptoAmount,
      assetRail: input.assetRail,
    },
    idempotencyKey: null,
  };
}

export async function estimateOfframp(c: ValidatedBodyContext<typeof estimateOfframpSchema>) {
  const input = c.req.valid("json");
  const row = OFFRAMP_SUPPORT.find(
    (pair) => pair.source === input.assetRail && pair.dest === input.fiatCurrency
  );
  const providers = row ? filterProviders(row.providers, resolveSdpEnvironment(c)) : [];

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
  } = getPolicyGateContext<CreateOfframpQuoteBody, RampQuotePolicyResolved>(c);

  await beginApprovedWalletOperationEffect(c);

  // Requirements/policy have succeeded. Reserve the ID now so the provider
  // quote and the eventual ledger row share the same internal transfer ID.
  const reservedTransferId = generatePaymentTransferId();
  // A keyed quote (the dashboard's stable operation key) reserves its durable
  // payment_transfers row BEFORE the provider call; see the on-ramp handler
  // for the reservation contract.
  const idempotencyKey = c.req.header(IDEMPOTENCY_KEY_HEADER) ?? null;
  const reservation: RampQuoteReservation | null =
    idempotencyKey === null
      ? null
      : await reserveKeyedRampQuoteTransfer(c, {
          idempotencyKey,
          idempotencyFingerprint: rampQuoteIdempotencyFingerprint({
            direction: "offramp",
            body: input,
            custodyWalletId: sourceWallet.id,
            walletAddress: sourceWalletAddress,
          }),
          transferId: reservedTransferId,
          direction: "offramp",
          organizationId: scope.auth.organizationId,
          projectId,
          counterpartyId: counterparty.id,
          provider: input.provider,
          custodyWalletId: sourceWallet.id,
          walletId: sourceWallet.walletId,
          walletAddress: sourceWalletAddress,
          assetRail: input.assetRail,
          token: rampTransferTokenMint(input.assetRail, c.env),
          sourceAddress: sourceWalletAddress,
          destinationAddress: null,
          amount: input.cryptoAmount,
          fiatCurrency: input.fiatCurrency ? input.fiatCurrency : null,
          fiatAmount: null,
          rampsMemo: input.rampsMemo,
          initiatedByKeyId: c.get("apiKey")?.id ?? null,
        });
  if (reservation && reservation.replay !== null) {
    return success(c, {
      quote: reservation.replay.quote,
      transferId: reservation.replay.transferId,
    });
  }
  const reservedRow = reservation?.row ?? null;
  const operationTransferId = reservedRow ? reservedRow.id : reservedTransferId;
  let quote: PaymentRampQuote;
  let precreatedTransferId: string | undefined;
  let transferProviderData: Record<string, unknown> | undefined;
  try {
    switch (input.provider) {
      case "moonpay": {
        const apiKey = c.get("apiKey");
        const pendingMoonpayTransfer =
          reservedRow ??
          (await getPaymentsRepository(c).createTransfer({
            id: operationTransferId,
            organizationId: scope.auth.organizationId,
            projectId,
            custodyWalletId: sourceWallet.id,
            walletId: sourceWallet.walletId,
            counterpartyId: counterparty.id,
            sourceAddress: sourceWalletAddress,
            destinationAddress: null,
            token: rampTransferTokenMint(input.assetRail, c.env),
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
          }));
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
            ...(idempotencyKey ? { providerData: rampQuoteResponseProviderData(quote) } : {}),
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
      case "lightspark": {
        if (!input.fiatCurrency) {
          throw badRequest("fiatCurrency is required for Lightspark off-ramp.");
        }
        const customerId = await lightsparkProviderCustomerId(c, counterparty, projectId);
        const purposeOfPayment = readLightsparkPurposeOfPayment(counterparty.provider_data);
        const accountsRepository = createPostgresCounterpartyProviderAccountsRepository(
          getDb(c.env)
        );
        let payoutAccount: CounterpartyProviderAccountRow | null;
        if (input.providerAccountId === undefined) {
          const payoutAccounts = await accountsRepository.listActiveExternalAccounts({
            organizationId: scope.auth.organizationId,
            projectId,
            counterpartyId: counterparty.id,
            provider: "lightspark",
            fiatCurrency: input.fiatCurrency,
            destinationCountry: input.destinationCountry,
          });
          payoutAccount = selectLightsparkPayoutAccount(
            payoutAccounts,
            input.fiatCurrency,
            input.destinationCountry
          );
        } else {
          payoutAccount = await requireLightsparkPayoutAccountById(c, {
            organizationId: scope.auth.organizationId,
            projectId,
            counterpartyId: counterparty.id,
            providerAccountId: input.providerAccountId,
            fiatCurrency: input.fiatCurrency,
            destinationCountry: input.destinationCountry,
          });
        }
        if (
          customerId === null ||
          purposeOfPayment === null ||
          payoutAccount === null ||
          payoutAccount.external_account_reference === null ||
          payoutAccount.provider_status === null ||
          !isLightsparkExternalAccountActive(payoutAccount.provider_status)
        ) {
          throw counterpartyNotProvisioned("lightspark", "offramp");
        }
        transferProviderData = { payoutProviderAccountId: payoutAccount.id };
        quote = await RAMP_PROVIDER_CLIENTS.lightspark.createOfframpQuote(rampRuntime(c), {
          assetRail: input.assetRail,
          fiatCurrency: input.fiatCurrency,
          cryptoAmount: input.cryptoAmount,
          sourceWalletAddress,
          externalCustomerId: counterparty.id,
          customerId,
          purposeOfPayment,
          payoutAccountId: payoutAccount.external_account_reference,
          description: operationTransferId,
        });
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
        const pendingTransfer =
          reservedRow ??
          (await createPendingBvnkOfframpTransfer(c, {
            transferId: operationTransferId,
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
          }));
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
          ...(idempotencyKey ? { response: bvnkQuote } : {}),
        });
        quote = bvnkQuote;
        precreatedTransferId = pendingTransfer.id;
        break;
      }
      case "moneygram": {
        quote = await RAMP_PROVIDER_CLIENTS.moneygram.createOfframpQuote(rampRuntime(c), {
          assetRail: input.assetRail,
          fiatCurrency: input.fiatCurrency,
          cryptoAmount: input.cryptoAmount,
          sourceWalletAddress,
          externalCustomerId: counterparty.id,
          paymentTransferId: operationTransferId,
        });
        break;
      }
      case "mural":
        throw internalError("Mural off-ramp quote is not implemented yet.");
      case "coinbase":
        throw badRequest("Coinbase Onramp does not support off-ramp.");
      case "stripe":
        throw badRequest("Stripe off-ramp is not supported.");
      default: {
        const exhaustive: never = input;
        throw internalError(
          `Off-ramp quote provider is not implemented: ${JSON.stringify(exhaustive)}`
        );
      }
    }
  } catch (error) {
    await failReservedRampQuoteTransfer(c, {
      reservedRow,
      organizationId: scope.auth.organizationId,
      projectId,
      error,
    });
    throw error;
  }

  let transferId: string;
  try {
    transferId = precreatedTransferId
      ? precreatedTransferId
      : await persistRampQuoteTransfer(c, {
          transferId: operationTransferId,
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
          providerData: transferProviderData,
          reservedRow,
          idempotencyKey,
        });
  } catch (error) {
    // See the on-ramp handler: a finalization failure must fail the keyed
    // reservation, not strand it pending with no stored response.
    await failReservedRampQuoteTransfer(c, {
      reservedRow,
      organizationId: scope.auth.organizationId,
      projectId,
      error,
    });
    throw error;
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
  const pairs: OfframpCurrencyPair[] = OFFRAMP_SUPPORT.flatMap((row) => {
    if (source && row.source !== source) return [];
    if (dest && row.dest !== dest) return [];
    const providers = filterProviders(row.providers, resolveSdpEnvironment(c), provider);
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
