import { SdpPaymentsError } from "@sdp/payments";
import { readyCounterparty } from "@sdp/payments/ramps/requirements";
import type { RampRuntimeContext } from "@sdp/payments/ramps/types";
import { redactCredentialString } from "@sdp/redaction";
import type {
  PaymentRampEstimate,
  PaymentRampQuote,
  RampProviderEstimateResult,
  SdpEnvironment,
} from "@sdp/types";
import {
  OFFRAMP_SUPPORT,
  ONRAMP_SUPPORT,
  RAMP_PROVIDER_SUPPORT_DETAILS,
  type RampFiatCurrency,
} from "@sdp/types/generated/ramp";
import type {
  CryptoRailId,
  OfframpPairSupport,
  OnrampPairSupport,
  RampProviderDirectionSupport,
} from "@sdp/types/payment-rails";
import { isRampProviderSurfaced, type RampProviderId } from "@sdp/types/provider-access";
import type { CounterpartyRequirements } from "@sdp/types/ramp-requirements";
import type { z } from "zod";
import { getDb } from "@/db";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import type {
  PaymentTransferRow,
  PaymentTransferStatus,
} from "@/db/repositories/payments.repository";
import { requireProjectId } from "@/lib/auth";
import { mapSettledWithConcurrency } from "@/lib/concurrency";
import {
  AppError,
  conflict,
  internalError,
  redactErrorForCapture,
  unsupportedRampCorridor,
} from "@/lib/errors";
import { getCounterpartiesRepository } from "@/routes/counterparties/context";
import type { SubmitCounterpartyRequirementsInput } from "@/routes/counterparties/schemas";
import { describeError, logEvent } from "@/runtime/money-path-events";
import { rampTransferTokenMint } from "@/services/payment-operation.service";
import {
  assertProviderAvailable,
  assertRampProviderSurfaced,
} from "@/services/provider-availability.service";
import {
  type AppContext,
  getPaymentsRepository,
  rampRuntime,
  resolveSdpEnvironment,
} from "../context";
import {
  assertFreshPaymentWalletAccess,
  assertPaymentWalletExactAccess,
  type ResolvedScope,
  resolveScope,
  resolveWalletByCustodyWalletId,
} from "../wallets";
import type { createOfframpQuoteSchema } from "./offramp/schemas";
import type { createOnrampQuoteSchema } from "./onramp/schemas";
import { advanceBvnkRequirements } from "./providers/bvnk";
import { advanceLightsparkRequirements } from "./providers/lightspark";
import { resolveMuralRequirements } from "./providers/mural";
import {
  assertRampQuoteBindingMatches,
  isRampQuoteBindingExpired,
  type RampQuoteBinding,
  rampQuoteCryptoDepositProviderData,
  rampQuoteExpiryProviderData,
} from "./quote-binding";
import { mergeRampQuoteProviderData, rampQuoteResponseProviderData } from "./quote-idempotency";

type ScopedSubmitCounterpartyRequirementsInput = SubmitCounterpartyRequirementsInput & {
  counterparty: CounterpartyRow;
  projectId: string;
};

export function filterProviders(
  providers: readonly RampProviderId[],
  environment: SdpEnvironment,
  provider?: RampProviderId
): RampProviderId[] {
  const surfaced = providers.filter((p) => isRampProviderSurfaced(p, environment));
  if (provider) {
    return surfaced.includes(provider) ? [provider] : [];
  }
  return surfaced;
}

export function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort();
}

export function buildProviderDetails(
  providerIds: readonly RampProviderId[],
  direction: "onramp" | "offramp"
): Partial<Record<RampProviderId, RampProviderDirectionSupport>> {
  const providerDetails: Partial<Record<RampProviderId, RampProviderDirectionSupport>> = {};
  for (const providerId of providerIds) {
    providerDetails[providerId] = RAMP_PROVIDER_SUPPORT_DETAILS[providerId][direction];
  }
  return providerDetails;
}

export function providersFromPairs(
  pairs: readonly { providers: readonly RampProviderId[] }[]
): RampProviderId[] {
  return uniqueSorted(pairs.flatMap((row) => row.providers));
}

/** Throws unless the org has the ramp provider enabled for the request's environment. */
export async function assertRampProviderAvailable(
  c: AppContext,
  providerId: RampProviderId,
  organizationId: string
): Promise<void> {
  await assertProviderAvailable(
    c.env,
    getDb(c.env),
    organizationId,
    "ramps",
    providerId,
    resolveSdpEnvironment(c) === "sandbox"
  );
}

type RampQuoteDirection = "onramp" | "offramp";

/**
 * Throws unless the committed corridor-support matrix (the same tables estimate
 * selects providers from) lists the provider for the requested crypto/fiat pair.
 * When fiatCurrency is omitted (off-ramp quotes may defer fiat selection to the
 * provider), the provider must support the crypto rail for at least one fiat.
 */
function assertRampCorridorSupported(
  direction: RampQuoteDirection,
  input: { provider: RampProviderId; assetRail: CryptoRailId; fiatCurrency?: RampFiatCurrency },
  environment: SdpEnvironment
): void {
  const { assetRail } = input;
  const pairs: readonly (OnrampPairSupport | OfframpPairSupport)[] =
    direction === "onramp" ? ONRAMP_SUPPORT : OFFRAMP_SUPPORT;
  const fiat = input.fiatCurrency;
  const matched = pairs.filter((pair) => {
    const railSide = direction === "onramp" ? pair.dest : pair.source;
    const fiatSide = direction === "onramp" ? pair.source : pair.dest;
    return railSide === assetRail && (fiat === undefined || fiatSide === fiat);
  });
  const supportedProviders = providersFromPairs(matched).filter((p) =>
    isRampProviderSurfaced(p, environment)
  );
  if (!supportedProviders.includes(input.provider)) {
    throw unsupportedRampCorridor(input.provider, direction, {
      assetRail,
      fiatCurrency: fiat,
      supportedProviders,
    });
  }
}
type ScopedRampWallet = ResolvedScope["wallets"][number];

export type CreateOnrampQuoteBody = z.output<typeof createOnrampQuoteSchema>;

export type CreateOfframpQuoteBody = z.output<typeof createOfframpQuoteSchema>;

export interface RampQuotePolicyResolved {
  scope: ResolvedScope;
  projectId: string;
  counterparty: CounterpartyRow;
  wallet: ScopedRampWallet;
  walletAddress: string;
}

interface PersistRampQuoteTransferInput {
  transferId: string;
  scope: ResolvedScope;
  projectId: string;
  counterparty: CounterpartyRow;
  quote: PaymentRampQuote;
  direction: RampQuoteDirection;
  wallet: ScopedRampWallet;
  walletAddress: string;
  assetRail: CryptoRailId;
  cryptoAmount: string | null;
  fiatCurrency: RampFiatCurrency | null;
  fiatAmount: string | null;
  rampsMemo: Record<string, string> | undefined;
  providerData?: Record<string, unknown>;
  /**
   * The keyed quote's pre-provider reservation (`reserveKeyedRampQuoteTransfer`):
   * when set, the quote finalizes THAT row instead of inserting a second one,
   * so a keyed retry can never mint a second payment transfer.
   */
  reservedRow?: PaymentTransferRow | null;
  /** The request's `Idempotency-Key`, present only on keyed quotes. */
  idempotencyKey?: string | null;
}

/**
 * Resolve the state shared by both ramp-quote extractions: corridor support,
 * provider availability, the counterparty, and the SDP wallet on the crypto
 * leg. The wallet is keyed by its internal custody wallet id.
 *
 * @param c - Request context.
 * @param direction - The quote direction.
 * @param input - The validated quote request body.
 * @param custodyWalletId - The internal custody wallet id from the request.
 * @returns The resolved scope, project, counterparty, wallet, and address.
 */
export async function resolveRampQuoteRequest(
  c: AppContext,
  direction: RampQuoteDirection,
  input: CreateOnrampQuoteBody | CreateOfframpQuoteBody,
  custodyWalletId: string
): Promise<RampQuotePolicyResolved> {
  assertRampProviderSurfaced(input.provider, resolveSdpEnvironment(c));
  assertRampCorridorSupported(direction, input, resolveSdpEnvironment(c));
  const scope = await resolveScope(c);
  await assertRampProviderAvailable(c, input.provider, scope.auth.organizationId);

  const projectId = requireProjectId(c);
  const counterparty = await getCounterpartiesRepository(c).getCounterpartyById({
    counterpartyId: input.counterpartyId,
    organizationId: scope.auth.organizationId,
    projectId,
  });
  if (!counterparty) {
    throw new AppError("NOT_FOUND", "Counterparty not found");
  }

  const wallet = resolveWalletByCustodyWalletId(scope.wallets, custodyWalletId);
  assertPaymentWalletExactAccess(c, wallet.id, ["payments:write"]);
  await assertFreshPaymentWalletAccess(c, wallet, ["payments:write"]);
  return { scope, projectId, counterparty, wallet, walletAddress: wallet.publicKey };
}

export function rampQuoteTransferStatus(quote: PaymentRampQuote): PaymentTransferStatus {
  if (quote.deliveryMode === "manual_instructions" && quote.status === "pending") {
    return "awaiting_payment";
  }
  return quote.status;
}

export async function persistRampQuoteTransfer(
  c: AppContext,
  input: PersistRampQuoteTransferInput
): Promise<string> {
  const repository = getPaymentsRepository(c);
  const isOnramp = input.direction === "onramp";
  const binding: RampQuoteBinding = {
    organizationId: input.scope.auth.organizationId,
    projectId: input.projectId,
    custodyWalletId: input.wallet.id,
    walletId: input.wallet.walletId,
    counterpartyId: input.counterparty.id,
    direction: input.direction,
    token: rampTransferTokenMint(input.assetRail, c.env),
    sourceAddress: isOnramp ? null : input.walletAddress,
    destinationAddress: isOnramp ? input.walletAddress : null,
    amount: input.cryptoAmount,
    fiatCurrency: input.fiatCurrency,
    fiatAmount: input.fiatAmount,
  };

  const existing = await repository.getTransferByProviderReference({
    provider: input.quote.provider,
    providerReference: input.quote.id,
    organizationId: input.scope.auth.organizationId,
    projectId: input.projectId,
  });
  if (existing) {
    // Idempotent replay only: the same reference with any changed input, or a
    // reference whose bound session/quote already expired, fails closed.
    assertRampQuoteBindingMatches(existing, binding);
    if (isRampQuoteBindingExpired(existing)) {
      throw conflict("Provider quote/session reference has expired; create a new quote.");
    }
    return existing.id;
  }

  // A keyed quote finalizes its pre-provider reservation instead of inserting
  // a second row, and records the verbatim quote response so a retried
  // operation can replay the ORIGINAL provider session.
  if (input.reservedRow) {
    assertRampQuoteBindingMatches(input.reservedRow, binding);
    try {
      const finalized = await repository.updateTransfer({
        transferId: input.reservedRow.id,
        organizationId: binding.organizationId,
        projectId: binding.projectId,
        status: rampQuoteTransferStatus(input.quote),
        providerReference: input.quote.id,
        deliveryMode: input.quote.deliveryMode,
        providerData: mergeRampQuoteProviderData(
          input.providerData ?? {},
          rampQuoteExpiryProviderData(input.quote),
          rampQuoteCryptoDepositProviderData(input.quote, input.cryptoAmount),
          ...(input.idempotencyKey ? [rampQuoteResponseProviderData(input.quote)] : [])
        ),
        updatedAt: new Date().toISOString(),
      });
      if (!finalized) {
        throw new AppError("INTERNAL_ERROR", "Failed to complete ramp transfer record");
      }
      return finalized.id;
    } catch (error) {
      // The (provider, provider_reference) unique index spans all tenants: a
      // reference already bound outside this tenant's scope surfaces here.
      if (isPostgresUniqueViolation(error)) {
        throw conflict(
          "Provider quote/session reference is already bound to a different ramp transfer."
        );
      }
      throw error;
    }
  }

  const apiKey = c.get("apiKey");
  let created: PaymentTransferRow | null;
  try {
    created = await repository.createTransfer({
      id: input.transferId,
      organizationId: binding.organizationId,
      projectId: binding.projectId,
      custodyWalletId: binding.custodyWalletId,
      walletId: binding.walletId,
      counterpartyId: binding.counterpartyId,
      sourceAddress: binding.sourceAddress,
      destinationAddress: binding.destinationAddress,
      token: binding.token,
      amount: binding.amount,
      memo: null,
      type: input.direction,
      direction: isOnramp ? "inbound" : "outbound",
      status: rampQuoteTransferStatus(input.quote),
      provider: input.quote.provider,
      providerReference: input.quote.id,
      deliveryMode: input.quote.deliveryMode,
      fiatCurrency: binding.fiatCurrency,
      fiatAmount: binding.fiatAmount,
      rampsMemo: input.rampsMemo,
      providerData: {
        ...(input.providerData ?? {}),
        ...rampQuoteExpiryProviderData(input.quote),
        ...rampQuoteCryptoDepositProviderData(input.quote, input.cryptoAmount),
      },
      serializedTx: null,
      signature: null,
      slot: null,
      initiatedByKeyId: apiKey ? apiKey.id : null,
    });
  } catch (error) {
    // The (provider, provider_reference) unique index spans all tenants: a
    // reference already bound outside this tenant's scope surfaces here.
    if (isPostgresUniqueViolation(error)) {
      throw conflict(
        "Provider quote/session reference is already bound to a different ramp transfer."
      );
    }
    throw error;
  }

  if (!created) {
    throw new AppError("INTERNAL_ERROR", "Failed to create ramp transfer record");
  }
  return created.id;
}

export async function advanceCounterpartyRequirements(
  c: AppContext,
  input: ScopedSubmitCounterpartyRequirementsInput
): Promise<CounterpartyRequirements> {
  switch (input.provider) {
    case "moonpay":
      return readyCounterparty("moonpay", input.direction);
    case "moneygram":
      return readyCounterparty("moneygram", input.direction);
    case "lightspark":
      return advanceLightsparkRequirements(c, input);
    case "bvnk":
      return advanceBvnkRequirements(c, input);
    case "mural":
      return resolveMuralRequirements(c, input.counterparty, input.projectId, input.direction);
    case "coinbase":
      return readyCounterparty("coinbase", input.direction);
    case "stripe":
      return readyCounterparty("stripe", input.direction);
    default: {
      const _exhaustive: never = input;
      throw internalError(`Unhandled ramp provider: ${_exhaustive}`);
    }
  }
}

/** Ceiling on simultaneous live provider estimate calls per request. */
export const RAMP_ESTIMATE_PROVIDER_CONCURRENCY = 3;

export async function estimateAcrossProviders(
  c: AppContext,
  providers: readonly RampProviderId[],
  runProvider: (provider: RampProviderId, ctx: RampRuntimeContext) => Promise<PaymentRampEstimate>
): Promise<RampProviderEstimateResult[]> {
  const scope = await resolveScope(c);
  const ctx = rampRuntime(c);

  const settled = await mapSettledWithConcurrency(
    [...providers],
    RAMP_ESTIMATE_PROVIDER_CONCURRENCY,
    async (provider): Promise<RampProviderEstimateResult> => {
      try {
        await assertRampProviderAvailable(c, provider, scope.auth.organizationId);
        const estimate = await runProvider(provider, ctx);
        return { provider, status: "ok", estimate };
      } catch (error) {
        if (error instanceof SdpPaymentsError && error.code === "ESTIMATE_NOT_AVAILABLE") {
          return { provider, status: "unsupported" };
        }
        const cause = error instanceof Error ? error : new Error(String(error));
        logEvent("error", {
          event: "sdp_api_ramp_provider_error",
          provider,
          organization_id: scope.auth.organizationId,
          error_message: redactCredentialString(cause.message),
          ...describeError(error),
        });
        const observability = c.get("observability");
        if (observability) {
          try {
            observability.withScope((sentryScope) => {
              sentryScope.setTag("provider", provider);
              sentryScope.setTag("organization_id", scope.auth.organizationId);
              observability.captureException(redactErrorForCapture(cause));
            });
          } catch {
            // never let telemetry change the per-provider error contract
          }
        }
        return {
          provider,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  );

  // The mapper catches internally, so every result is fulfilled.
  return settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
}
