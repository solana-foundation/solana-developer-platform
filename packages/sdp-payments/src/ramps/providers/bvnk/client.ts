import { assertValidAddress } from "@sdp/solana/address";
import { toNumberAmount } from "@sdp/solana/amount";
import type {
  Counterparty,
  PaymentRampEstimate,
  PaymentRampQuote,
  SdpEnvironment,
} from "@sdp/types";
import { getCryptoRailAssetLabel } from "@sdp/types/payment-rails";
import type { CounterpartyRequirements } from "@sdp/types/ramp-requirements";
import { z } from "zod";
import {
  addDecimalAmounts,
  compareDecimalAmounts,
  decimalStringFromNumber,
  divideDecimalAmounts,
  subtractDecimalAmounts,
} from "../../../decimal";
import {
  badRequest,
  internalError,
  providerNotConfigured,
  providerUnavailable,
} from "../../../errors";
import { hmacSha256Base64 } from "../../../hash";
import { type ProviderRequestInit, providerFetch } from "../../fetch";
import { rampId, UNREPORTED_COUNTRY_SUPPORT } from "../../shared";
import type {
  ProviderDeclaredRailSupport,
  ProviderRailSupportDistillation,
  RampDiscoveryContext,
  RampEstimateOfframpInput,
  RampEstimateOnrampInput,
  RampOfframpQuoteInput,
  RampProvider,
  RampRuntimeContext,
  ValidateCounterpartyOptions,
} from "../../types";
import { validateBvnkCounterparty } from "./counterparty";
import { discoverBvnkCurrencyAndRails } from "./currencies";
import { bvnkRequestFailure, parseBvnkResponse } from "./errors";
import {
  type BvnkNetwork,
  buildBvnkOfframpReference,
  normalizeBvnkCurrencyAndNetwork,
} from "./provider-data";
import {
  type BvnkChannelAddress,
  type BvnkChannelResponse,
  type BvnkContactsV3ListResponse,
  type BvnkContactV3,
  type BvnkLedgerWalletProfilesV2,
  type BvnkLedgerWalletV2,
  type BvnkRuleListEntry,
  type BvnkRuleResponse,
  type BvnkSandboxPayinCurrency,
  bvnkChannelResponseSchema,
  bvnkContactsV3ListResponseSchema,
  bvnkContactV3Schema,
  bvnkOfframpQuoteInputSchema,
  bvnkPayoutEstimateResponseSchema,
  bvnkQuoteEstimateResponseSchema,
  bvnkRuleListResponseSchema,
  bvnkRuleResponseSchema,
  bvnkSandboxPayinCurrencySchema,
  bvnkV2LedgerWalletSchema,
  bvnkV2WalletProfilesSchema,
  type CreateBvnkContactV3Input,
  type CreateBvnkLedgerWalletV2Input,
  type CreateBvnkOnrampRuleInput,
  type ListBvnkLedgerWalletProfilesV2Input,
} from "./schemas";

const BVNK_PRODUCTION_API_URL = "https://api.bvnk.com";
export const BVNK_SANDBOX_API_URL = "https://api.sandbox.bvnk.com";

export const BVNK_DECLARED_RAIL_SUPPORT = {
  onramp: {
    countrySupport: UNREPORTED_COUNTRY_SUPPORT,
    entityTypes: ["individual"],
  },
  offramp: {
    countrySupport: UNREPORTED_COUNTRY_SUPPORT,
    entityTypes: ["individual", "business"],
  },
} as const satisfies ProviderDeclaredRailSupport;

interface BvnkSandboxBankAccount {
  accountNumber: string;
  accountNumberFormat: string;
  bankCode?: string;
}

// SANDBOX ONLY: synthetic originator (fiat sender) bank accounts for pay-in
// simulations. The real buyer's funding bank is never stored; BVNK just needs
// a format-valid account to accept the simulated deposit. Never used in prod.
const SANDBOX_ORIGINATOR_BANK_ACCOUNTS = {
  // biome-ignore lint/security/noSecrets: synthetic sandbox account, not a credential
  USD: { accountNumber: "000123456789", accountNumberFormat: "ABA", bankCode: "021000021" },
  // biome-ignore lint/security/noSecrets: synthetic sandbox account, not a credential
  EUR: { accountNumber: "GB29NWBK60161331926819", accountNumberFormat: "IBAN" },
} as const satisfies Record<BvnkSandboxPayinCurrency, BvnkSandboxBankAccount>;

interface BvnkConfig {
  auth: { authId: string; secretKey: string };
  walletId: string;
  apiBaseUrl: string;
}

function readBvnkConfig(env: Record<string, string | undefined>, mode: SdpEnvironment): BvnkConfig {
  const authId = (
    mode === "sandbox" ? env.BVNK_SANDBOX_HAWK_AUTH_ID : env.BVNK_HAWK_AUTH_ID
  )?.trim();
  const secretKey = (
    mode === "sandbox" ? env.BVNK_SANDBOX_HAWK_SECRET_KEY : env.BVNK_HAWK_SECRET_KEY
  )?.trim();
  const walletId = (mode === "sandbox" ? env.BVNK_SANDBOX_WALLET_ID : env.BVNK_WALLET_ID)?.trim();

  if (!walletId || !authId || !secretKey) {
    throw providerNotConfigured(
      mode === "sandbox"
        ? "BVNK sandbox is not configured. Set BVNK_SANDBOX_WALLET_ID, BVNK_SANDBOX_HAWK_AUTH_ID, and BVNK_SANDBOX_HAWK_SECRET_KEY."
        : "BVNK is not configured. Set BVNK_WALLET_ID, BVNK_HAWK_AUTH_ID, and BVNK_HAWK_SECRET_KEY."
    );
  }

  const apiBaseUrl = mode === "sandbox" ? BVNK_SANDBOX_API_URL : BVNK_PRODUCTION_API_URL;

  return { auth: { authId, secretKey }, walletId, apiBaseUrl };
}

async function buildBvnkHawkAuthorizationHeader(
  url: URL,
  method: ProviderRequestInit<unknown>["method"],
  authId: string,
  secretKey: string
): Promise<string> {
  const ts = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const resource = `${url.pathname}${url.search}`;

  const normalized = [
    "hawk.1.header",
    ts,
    nonce,
    method,
    resource,
    url.hostname,
    "443",
    "",
    "",
    "",
  ].join("\n");

  const mac = await hmacSha256Base64(normalized, secretKey);
  return `Hawk id="${authId}", ts="${ts}", nonce="${nonce}", mac="${mac}"`;
}

/** Picks the deposit address for the requested network from the channel's primary slot or alternatives. */
function parseBvnkChannelAddress(channel: BvnkChannelResponse, network: BvnkNetwork): string {
  const candidates: BvnkChannelAddress[] = [{ network: channel.network, address: channel.address }];
  if (channel.alternatives) {
    candidates.push(...channel.alternatives);
  }
  const match = candidates.find((candidate) => candidate.network === network);
  if (!match) {
    throw badRequest(`BVNK channel did not return a ${network} deposit address.`);
  }
  return match.address;
}

function assertPositiveDecimalAmount(value: string, fieldName: string): string {
  if (compareDecimalAmounts(value, "0") <= 0) {
    throw badRequest(`${fieldName} must be a positive amount`);
  }
  return value;
}

export class BvnkRampClient implements RampProvider {
  readonly id = "bvnk";
  readonly declaredRailSupport = BVNK_DECLARED_RAIL_SUPPORT;

  private async request(
    config: BvnkConfig,
    path: string,
    init: {
      method: ProviderRequestInit<unknown>["method"];
      body?: unknown;
      headers?: Record<string, string>;
    }
  ): Promise<unknown> {
    const url = new URL(path, config.apiBaseUrl);
    const authorization = await buildBvnkHawkAuthorizationHeader(
      url,
      init.method,
      config.auth.authId,
      config.auth.secretKey
    );

    const { response, raw, parsed } = await providerFetch(this.id, url.toString(), {
      ...init,
      headers: {
        Authorization: authorization,
        ...init.headers,
      },
    });

    if (!response.ok) {
      throw bvnkRequestFailure(response.status, raw, parsed);
    }

    if (parsed === undefined) {
      if (response.status === 204) {
        return undefined;
      }
      throw providerUnavailable("BVNK returned an unparseable response", {
        provider: this.id,
      });
    }
    return parsed;
  }

  validateCounterparty(
    counterparty: Counterparty,
    options: ValidateCounterpartyOptions
  ): CounterpartyRequirements {
    return validateBvnkCounterparty(counterparty, options);
  }

  async discoverCurrencyAndRails(
    context: RampDiscoveryContext
  ): Promise<ProviderRailSupportDistillation> {
    return discoverBvnkCurrencyAndRails(context);
  }

  /**
   * Creates a v2 ledger wallet on the merchant account. Wallets are
   * merchant-owned in the Direct model, so no customerId is ever sent.
   *
   * @param ctx - Runtime provider credentials and environment.
   * @param input - Wallet details and an idempotency key derived deterministically from canonical SDP ids.
   * @returns The typed ledger wallet, including fiat payment instruments when present.
   */
  async createLedgerWalletV2(
    { env, mode }: RampRuntimeContext,
    input: CreateBvnkLedgerWalletV2Input
  ): Promise<BvnkLedgerWalletV2> {
    const config = readBvnkConfig(env, mode);
    const response = await this.request(config, "/ledger/v2/wallets", {
      method: "POST",
      headers: { "Idempotency-Key": input.idempotencyKey },
      body: {
        currency: input.currency,
        name: input.name,
        ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
      },
    });
    const parsed = parseBvnkResponse(bvnkV2LedgerWalletSchema, response);
    return {
      ...parsed,
      balance: {
        amount: decimalStringFromNumber(parsed.balance.amount),
        currency: parsed.balance.currency,
      },
    };
  }

  /**
   * Retrieves a v2 ledger wallet.
   *
   * @param ctx - Runtime provider credentials and environment.
   * @param input - Wallet id.
   * @returns The typed ledger wallet, including fiat payment instruments when present.
   */
  async getLedgerWalletV2(
    { env, mode }: RampRuntimeContext,
    input: { walletId: string }
  ): Promise<BvnkLedgerWalletV2> {
    const config = readBvnkConfig(env, mode);
    const response = await this.request(
      config,
      `/ledger/v2/wallets/${encodeURIComponent(input.walletId)}`,
      { method: "GET" }
    );
    const parsed = parseBvnkResponse(bvnkV2LedgerWalletSchema, response);
    return {
      ...parsed,
      balance: {
        amount: decimalStringFromNumber(parsed.balance.amount),
        currency: parsed.balance.currency,
      },
    };
  }

  /**
   * Creates a v3 contact holding the counterparty's identity for Travel Rule
   * compliance. No idempotency key: BVNK does not document one for this
   * endpoint, so duplicate-creation protection comes from the customer-link
   * row reservation in the calling handler.
   *
   * @param ctx - Runtime provider credentials and environment.
   * @param input - The counterparty id as the contact description and the entity body.
   * @returns The typed contact with its BVNK-assigned id.
   */
  async createContactV3(
    { env, mode }: RampRuntimeContext,
    input: CreateBvnkContactV3Input
  ): Promise<BvnkContactV3> {
    const config = readBvnkConfig(env, mode);
    const response = await this.request(config, "/platform/v3/contacts", {
      method: "POST",
      body: { description: input.description, entity: input.entity },
    });
    return parseBvnkResponse(bvnkContactV3Schema, response);
  }

  /**
   * Retrieves a v3 contact by its BVNK-assigned id.
   *
   * @param ctx - Runtime provider credentials and environment.
   * @param input - The contact id stored as the counterparty's provider customer reference.
   * @returns The typed contact.
   */
  async getContactV3(
    { env, mode }: RampRuntimeContext,
    input: { contactId: string }
  ): Promise<BvnkContactV3> {
    const config = readBvnkConfig(env, mode);
    const response = await this.request(
      config,
      `/platform/v3/contacts/${encodeURIComponent(input.contactId)}`,
      { method: "GET" }
    );
    return parseBvnkResponse(bvnkContactV3Schema, response);
  }

  /**
   * Lists one page of v3 contacts matching a search query. The counterparty
   * id is stored as the contact description, so listing by that id is the
   * crash-recovery lookup for an interrupted contact creation. The caller
   * follows `hasNext` pages and fails closed when the search does not
   * converge, so a page boundary can never hide an existing contact.
   *
   * @param ctx - Runtime provider credentials and environment.
   * @param input - Search query, page size, and zero-based page number.
   * @returns The page of matching contacts plus its pagination metadata.
   */
  async listContactsV3(
    { env, mode }: RampRuntimeContext,
    input: { q: string; pageSize: number; pageNumber: number }
  ): Promise<BvnkContactsV3ListResponse> {
    const config = readBvnkConfig(env, mode);
    const response = await this.request(
      config,
      `/platform/v3/contacts?q=${encodeURIComponent(input.q)}&pageSize=${input.pageSize}&pageNumber=${input.pageNumber}`,
      { method: "GET" }
    );
    return parseBvnkResponse(bvnkContactsV3ListResponseSchema, response);
  }

  /**
   * Deletes a v3 contact by its BVNK-assigned id. Used to remove a contact
   * this request created but could not bind to the customer-link row because
   * a concurrent advance completed the row first; a bound contact is never
   * deleted.
   *
   * @param ctx - Runtime provider credentials and environment.
   * @param input - The contact id to delete.
   * @returns Nothing; BVNK answers 204 on success.
   */
  async deleteContactV3(
    { env, mode }: RampRuntimeContext,
    input: { contactId: string }
  ): Promise<void> {
    const config = readBvnkConfig(env, mode);
    await this.request(config, `/platform/v3/contacts/${encodeURIComponent(input.contactId)}`, {
      method: "DELETE",
    });
  }

  /**
   * Lists v2 ledger wallet profiles and their supported payment rails.
   *
   * @param ctx - Runtime provider credentials and environment.
   * @param input - Optional currency filter.
   * @returns The paginated wallet-profile response.
   */
  async listLedgerWalletProfilesV2(
    { env, mode }: RampRuntimeContext,
    input?: ListBvnkLedgerWalletProfilesV2Input
  ): Promise<BvnkLedgerWalletProfilesV2> {
    const config = readBvnkConfig(env, mode);
    const filters = [
      input?.currency === undefined ? undefined : `currency:${input.currency}`,
    ].filter((filter): filter is string => filter !== undefined);
    const path =
      filters.length === 0
        ? "/ledger/v2/wallets/profiles"
        : `/ledger/v2/wallets/profiles?q=${encodeURIComponent(filters.join(" AND "))}`;
    const response = await this.request(config, path, { method: "GET" });
    return parseBvnkResponse(bvnkV2WalletProfilesSchema, response);
  }

  async createOnrampRule(
    { env, mode }: RampRuntimeContext,
    input: CreateBvnkOnrampRuleInput
  ): Promise<BvnkRuleResponse> {
    const config = readBvnkConfig(env, mode);
    const response = await this.request(config, "/payment/v1/rules", {
      method: "POST",
      body: {
        reference: input.reference,
        trigger: "payment:payin:fiat",
        walletId: input.walletId,
        beneficiary: {
          currency: input.currency,
          entity: input.entity,
          cryptoAddress: { network: input.network, address: input.beneficiaryAddress },
        },
      },
    });
    return parseBvnkResponse(bvnkRuleResponseSchema, response);
  }

  /**
   * Lists the payment rules applied to a wallet. The Direct model recovers a
   * transfer whose rule was created but never CAS'd onto the row by adopting
   * the active rule whose reference matches `sdp_onramp_<transfer_id>`; the
   * per-key provisioning path likewise adopts the ACTIVE rule whose reference
   * matches the deterministic rule reference for the funding key, so an
   * interrupted create never strands a duplicate.
   *
   * @param ctx - Runtime provider credentials and environment.
   * @param input - BVNK wallet id to list rules for.
   * @returns The wallet's payment rules in BVNK order.
   */
  async listOnrampRulesByWallet(
    { env, mode }: RampRuntimeContext,
    input: { walletId: string }
  ): Promise<BvnkRuleListEntry[]> {
    const config = readBvnkConfig(env, mode);
    const response = await this.request(
      config,
      `/payment/v1/rules/${encodeURIComponent(input.walletId)}`,
      { method: "GET" }
    );
    return parseBvnkResponse(bvnkRuleListResponseSchema, response);
  }

  /**
   * Deactivates a payment rule. Deactivated rules cannot be reactivated, so a
   * fresh rule is created per on-ramp transfer.
   *
   * @param ctx - Runtime provider credentials and environment.
   * @param input - BVNK rule id to deactivate.
   * @returns Resolves when BVNK confirms the deactivation (204).
   */
  async deactivateOnrampRule(
    { env, mode }: RampRuntimeContext,
    input: { ruleId: string }
  ): Promise<void> {
    const config = readBvnkConfig(env, mode);
    await this.request(config, `/payment/v1/rules/${encodeURIComponent(input.ruleId)}/actions`, {
      method: "POST",
      body: { type: "DEACTIVATE" },
    });
  }

  async simulatePayin(
    { env, mode }: RampRuntimeContext,
    input: {
      walletId: string;
      amount: number;
      currency: string;
      originatorName: string;
      remittanceInformation: string;
      idempotencyKey: string;
    }
  ): Promise<unknown> {
    const currency = bvnkSandboxPayinCurrencySchema.safeParse(input.currency);
    if (!currency.success) {
      throw badRequest("BVNK sandbox pay-in simulation supports USD and EUR only.");
    }
    const config = readBvnkConfig(env, mode);
    return this.request(config, "/payment/v2/payins/simulation", {
      method: "POST",
      headers: { "Idempotency-Key": input.idempotencyKey },
      body: {
        walletId: input.walletId,
        amount: input.amount,
        currency: currency.data,
        remittanceInformation: input.remittanceInformation,
        originator: {
          name: input.originatorName,
          bankAccount: SANDBOX_ORIGINATOR_BANK_ACCOUNTS[currency.data],
        },
      },
    });
  }

  async estimateOnramp(
    { env, mode }: RampRuntimeContext,
    input: RampEstimateOnrampInput
  ): Promise<PaymentRampEstimate> {
    const config = readBvnkConfig(env, mode);
    const { currency } = normalizeBvnkCurrencyAndNetwork(getCryptoRailAssetLabel(input.assetRail));
    const amountIn = assertPositiveDecimalAmount(input.fiatAmount, "fiatAmount");
    const quoteResponse = await this.request(config, "/api/v1/quote?estimate=true", {
      method: "POST",
      body: {
        from: input.fiatCurrency,
        to: currency,
        fromWalletLsid: config.walletId,
        toWalletLsid: config.walletId,
        amountIn: toNumberAmount(amountIn),
        useMinimum: false,
        useMaximum: false,
        payInMethod: "wallet",
        payOutMethod: "wallet",
      },
    });
    const quote = parseBvnkResponse(bvnkQuoteEstimateResponseSchema, quoteResponse);
    const feeCurrency = quote.payInMethod.settlementCurrency;
    if (feeCurrency !== input.fiatCurrency) {
      throw providerUnavailable("BVNK returned on-ramp fees outside the fiat pay-in currency");
    }
    const fiatAmount = decimalStringFromNumber(quote.amountIn);
    const cryptoAmount = decimalStringFromNumber(quote.amountOut);
    const service = decimalStringFromNumber(quote.fees.value.service);
    const processing = decimalStringFromNumber(quote.fees.value.processing);
    const totalFee = addDecimalAmounts(service, processing);
    return {
      provider: this.id,
      direction: "onramp",
      fiatCurrency: input.fiatCurrency,
      assetRail: input.assetRail,
      fiatAmount,
      cryptoAmount,
      exchangeRate: divideDecimalAmounts(fiatAmount, cryptoAmount),
      fees: {
        currency: input.fiatCurrency,
        total: totalFee,
        provider: totalFee,
        providerCurrency: input.fiatCurrency,
      },
      expiresAt: new Date(quote.acceptanceExpiryDate).toISOString(),
    };
  }

  async estimateOfframp(
    { env, mode }: RampRuntimeContext,
    input: RampEstimateOfframpInput
  ): Promise<PaymentRampEstimate> {
    const config = readBvnkConfig(env, mode);
    const { currency, network } = normalizeBvnkCurrencyAndNetwork(
      getCryptoRailAssetLabel(input.assetRail)
    );
    const paidRequiredAmount = assertPositiveDecimalAmount(input.cryptoAmount, "cryptoAmount");
    const estimateResponse = await this.request(config, "/api/v1/pay/estimate", {
      method: "POST",
      body: {
        walletId: config.walletId,
        walletCurrency: input.fiatCurrency,
        paidCurrency: currency,
        paidRequiredAmount: toNumberAmount(paidRequiredAmount),
        reference: rampId("sdp_offramp_est"),
        network,
      },
    });
    const estimate = parseBvnkResponse(bvnkPayoutEstimateResponseSchema, estimateResponse);
    const feeCurrency = estimate.feeCurrency;
    const networkFeeCurrency = estimate.networkFeeCurrency;
    if (estimate.feePredictedAmount > 0 && feeCurrency !== input.fiatCurrency) {
      throw providerUnavailable("BVNK returned provider fees outside the fiat output currency");
    }
    if (estimate.networkFeePredictedAmount > 0 && networkFeeCurrency !== input.fiatCurrency) {
      throw providerUnavailable("BVNK returned network fees outside the fiat output currency");
    }
    const totalFeeCurrency = estimate.feePredictedAmount > 0 ? feeCurrency : networkFeeCurrency;
    const gross = decimalStringFromNumber(estimate.walletRequiredAmount);
    const fee = decimalStringFromNumber(estimate.feePredictedAmount);
    const networkFee = decimalStringFromNumber(estimate.networkFeePredictedAmount);
    const totalFee = addDecimalAmounts(fee, networkFee);
    if (compareDecimalAmounts(gross, totalFee) < 0) {
      throw providerUnavailable("BVNK returned estimate fees above the gross amount");
    }
    const netFiatAmount = subtractDecimalAmounts(gross, totalFee);
    const cryptoAmount = decimalStringFromNumber(estimate.paidRequiredAmount);
    return {
      provider: this.id,
      direction: "offramp",
      fiatCurrency: input.fiatCurrency,
      assetRail: input.assetRail,
      fiatAmount: netFiatAmount,
      cryptoAmount,
      exchangeRate: divideDecimalAmounts(netFiatAmount, cryptoAmount),
      fees: {
        currency: totalFeeCurrency,
        total: totalFee,
        provider: fee,
        providerCurrency: feeCurrency,
        network: networkFee,
        networkCurrency: networkFeeCurrency,
      },
    };
  }

  async createOfframpQuote(
    { env, mode }: RampRuntimeContext,
    input: RampOfframpQuoteInput
  ): Promise<PaymentRampQuote> {
    const parsed = bvnkOfframpQuoteInputSchema.safeParse(input);
    if (!parsed.success) {
      throw internalError("BVNK off-ramp input is incomplete.", {
        issues: z.flattenError(parsed.error).fieldErrors,
      });
    }
    const config = readBvnkConfig(env, mode);
    const { currency, network } = normalizeBvnkCurrencyAndNetwork(
      getCryptoRailAssetLabel(input.assetRail)
    );
    const reference = buildBvnkOfframpReference(parsed.data.paymentTransferId);

    const channelResponse = await this.request(config, "/api/v2/channel", {
      method: "POST",
      body: {
        walletId: parsed.data.bvnkOfframpWalletId,
        payCurrency: currency,
        displayCurrency: parsed.data.fiatCurrency,
        reference,
        customerId: parsed.data.externalCustomerId,
        complianceDetails: { contactId: parsed.data.contactId },
      },
    });
    const channel = parseBvnkResponse(bvnkChannelResponseSchema, channelResponse);
    const destinationAddress = assertValidAddress(
      parseBvnkChannelAddress(channel, network),
      "BVNK channel deposit address"
    );

    return {
      provider: "bvnk",
      id: channel.uuid,
      status: "pending",
      deliveryMode: "manual_instructions",
      paymentInstructions: [
        {
          provider: "bvnk",
          kind: "crypto_deposit",
          fiatCurrency: parsed.data.fiatCurrency,
          cryptoCurrency: currency,
          destinationAddress,
          network,
          reference,
          instructionsNotes: `Send ${currency} on ${network} to the deposit address. BVNK converts it to ${parsed.data.fiatCurrency} and pays out to the registered bank account.`,
        },
      ],
    };
  }
}
