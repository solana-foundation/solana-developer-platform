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
  SdpPaymentsError,
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
  BVNK_PAYOUT_NETWORK,
  type BvnkNetwork,
  buildBvnkOfframpReference,
  normalizeBvnkCurrencyAndNetwork,
} from "./provider-data";
import {
  type BvnkAgreementSession,
  type BvnkChannelAddress,
  type BvnkChannelResponse,
  type BvnkCustomer,
  type BvnkCustomerCreated,
  type BvnkDryRunPayoutResponse,
  type BvnkLedgerWalletProfilesV2,
  type BvnkLedgerWalletV2,
  type BvnkOnrampPayoutInput,
  type BvnkOnrampPayoutSummary,
  type BvnkSandboxPayinCurrency,
  type BvnkV2WalletList,
  bvnkAgreementSessionSchema,
  bvnkChannelResponseSchema,
  bvnkCustomerCreatedSchema,
  bvnkCustomerSchema,
  bvnkDryRunPayoutResponseSchema,
  bvnkOfframpQuoteInputSchema,
  bvnkOnrampPayoutSummarySchema,
  bvnkPayoutEstimateResponseSchema,
  bvnkQuoteEstimateResponseSchema,
  bvnkSandboxPayinCurrencySchema,
  bvnkV2LedgerWalletSchema,
  bvnkV2WalletListSchema,
  bvnkV2WalletProfilesSchema,
  type CreateBvnkAgreementSessionInput,
  type CreateBvnkCustomerInput,
  type CreateBvnkLedgerWalletV2Input,
  type ListBvnkLedgerWalletProfilesV2Input,
  type SignBvnkAgreementSessionInput,
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
} as const satisfies Record<BvnkSandboxPayinCurrency, BvnkSandboxBankAccount>;

const SANDBOX_PAYIN_METHODS = {
  USD: "ACH",
} as const satisfies Record<BvnkSandboxPayinCurrency, string>;

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

/** BVNK pay-family business error codes the reconciler branches on. */
export type BvnkPayErrorCode = "MER-PAY-2010" | "MER-PAY-2012" | "MER-PAY-2001" | "MER-PAY-2009";

/**
 * A typed BVNK pay-family business error, carrying the provider code the
 * reconciler branches on. `MER-PAY-2010` (duplicate reference, probe step 4)
 * is ambiguous — BVNK dedupes on `reference` alone, so the reconciler adopts
 * the existing payout. `MER-PAY-2012` (insufficient funds), `MER-PAY-2001`
 * (below minimum), and `MER-PAY-2009` (invalid request) are definitive
 * rejections on a first attempt. Unknown provider codes never map to this
 * class — they surface as the generic `SdpPaymentsError` from
 * {@link bvnkRequestFailure} and stay unresolved.
 */
export class BvnkPayRequestError extends SdpPaymentsError {
  readonly bvnkCode: BvnkPayErrorCode;

  constructor(bvnkCode: BvnkPayErrorCode, message: string) {
    super("BAD_REQUEST", message);
    this.name = this.constructor.name;
    this.bvnkCode = bvnkCode;
  }
}

/** The pay error fields read from either BVNK non-2xx envelope. */
interface BvnkPayErrorFields {
  code: string;
  message?: string;
}

/**
 * Parses the BVNK pay error from a non-2xx body in one pass. BVNK uses two
 * envelopes: `errorList[].code` (create/duplicate/insufficient, probe steps
 * 4/7) and a top-level `code` (validation, probe step 10); the first
 * `errorList` entry wins when both are present, and its message is read from
 * the same entry.
 *
 * @param parsed - Parsed response body, or undefined for non-JSON bodies.
 * @returns The first error code and message, or undefined when neither envelope carries a code.
 */
function readBvnkPayError(parsed: unknown): BvnkPayErrorFields | undefined {
  if (parsed === null || typeof parsed !== "object") {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  const errorList = record.errorList;
  if (Array.isArray(errorList)) {
    const first = errorList[0];
    if (first !== null && typeof first === "object") {
      const listEntry = first as Record<string, unknown>;
      if (typeof listEntry.code === "string") {
        return {
          code: listEntry.code,
          ...(typeof listEntry.message === "string" ? { message: listEntry.message } : {}),
        };
      }
    }
  }
  if (typeof record.code !== "string") {
    return undefined;
  }
  return {
    code: record.code,
    ...(typeof record.message === "string" ? { message: record.message } : {}),
  };
}

/**
 * Normalizes a non-2xx BVNK pay-family response into an SdpPaymentsError.
 * Known MER-PAY codes map to {@link BvnkPayRequestError} regardless of the
 * HTTP status (business errors arrive as 400 or 404 JSON, probe step 2);
 * unknown codes and non-pay shapes fall back to the generic
 * {@link bvnkRequestFailure} mapping and are never coerced into a default
 * typed class.
 *
 * @param status - HTTP status BVNK returned.
 * @param raw - Raw response body text.
 * @param parsed - Parsed response body, when the response was JSON.
 * @returns The typed or generic failure error for the pay response.
 */
function bvnkPayRequestError(status: number, raw: string, parsed: unknown): SdpPaymentsError {
  const fields = readBvnkPayError(parsed);
  if (fields === undefined) {
    return bvnkRequestFailure(status, raw, parsed);
  }
  const detail =
    fields.message === undefined
      ? `BVNK request failed with status ${status}: ${fields.code}`
      : `BVNK request failed with status ${status}: ${fields.code} ${fields.message}`;
  switch (fields.code) {
    case "MER-PAY-2010":
    case "MER-PAY-2012":
    case "MER-PAY-2001":
    case "MER-PAY-2009":
      return new BvnkPayRequestError(fields.code, detail);
    default:
      return bvnkRequestFailure(status, raw, parsed);
  }
}

/**
 * Builds the shared on-ramp payout request body for create and dry-run, with
 * the network code forced per endpoint (`BVNK_PAYOUT_NETWORK.create` vs
 * `dryRun`): BVNK rejects `SOLANA` on dry-run and `SOL` on create.
 *
 * @param input - The intended payout request.
 * @param network - The endpoint-specific network code.
 * @returns The wire body for `POST /api/v1/pay/summary` (or its dry-run sibling).
 */
function bvnkOnrampPayoutBody(
  input: BvnkOnrampPayoutInput,
  network: string
): Record<string, unknown> {
  return {
    walletId: input.walletId,
    type: "OUT",
    amount: input.amount,
    currency: input.currency,
    reference: input.reference,
    customerId: input.customerId,
    payOutDetails: { ...input.payOutDetails, network },
    complianceDetails: input.complianceDetails,
  };
}

export class BvnkRampClient implements RampProvider {
  readonly id = "bvnk";
  readonly declaredRailSupport = BVNK_DECLARED_RAIL_SUPPORT;

  /**
   * Executes a Hawk-signed BVNK request. Every request is fenced by
   * `AbortSignal.timeout(30_000)` covering both the fetch and the response
   * body read (R10), so a hung BVNK call can never outlive its fence. Non-2xx
   * responses throw through the optional pay-family error parser when
   * provided, else through the generic BVNK failure mapping.
   *
   * @param config - BVNK credentials and API base URL.
   * @param path - API path, for example `/api/v1/pay/summary`.
   * @param init - HTTP method, optional JSON body, and optional headers.
   * @param parseError - Optional normalizer for non-2xx bodies; the pay family
   *   passes one that maps MER-PAY codes onto typed errors.
   * @returns The parsed JSON response body, or undefined for empty bodies.
   */
  private async request(
    config: BvnkConfig,
    path: string,
    init: {
      method: ProviderRequestInit<unknown>["method"];
      body?: unknown;
      headers?: Record<string, string>;
    },
    parseError?: (status: number, raw: string, parsed: unknown) => SdpPaymentsError
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
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw parseError === undefined
        ? bvnkRequestFailure(response.status, raw, parsed)
        : parseError(response.status, raw, parsed);
    }

    if (parsed === undefined) {
      if (response.status === 204 || raw.trim() === "") {
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
   * Creates a v1 agreement session for a prospective BVNK customer. The
   * customer type and use case are fixed constants of the SDP individual on-ramp.
   * The idempotency header is sent as best-effort provider-side dedupe — BVNK
   * does not document it for this endpoint, so the customer-link row
   * reservation is the authority on duplicate mints.
   *
   * @param ctx - Runtime provider credentials and environment.
   * @param input - Residence country whose agreement set the session mints, and the row-uuid idempotency key.
   * @returns The created agreement session with its static document links.
   */
  async createAgreementSession(
    { env, mode }: RampRuntimeContext,
    input: CreateBvnkAgreementSessionInput
  ): Promise<BvnkAgreementSession> {
    const config = readBvnkConfig(env, mode);
    const response = await this.request(config, "/platform/v1/customers/agreement/sessions", {
      method: "POST",
      headers: { "X-Idempotency-Key": input.idempotencyKey },
      body: {
        customerType: "INDIVIDUAL",
        countryCode: input.countryCode,
        useCase: "EMBEDDED_FIAT_ACCOUNTS",
      },
    });
    return parseBvnkResponse(bvnkAgreementSessionSchema, response);
  }

  /**
   * Signs a v1 agreement session with the consenting end-user IP. BVNK returns
   * an empty 204, which the client treats as success with no body.
   *
   * @param ctx - Runtime provider credentials and environment.
   * @param input - Session reference and the consenting user's IP address.
   * @returns Nothing.
   */
  async signAgreementSession(
    { env, mode }: RampRuntimeContext,
    input: SignBvnkAgreementSessionInput
  ): Promise<void> {
    const config = readBvnkConfig(env, mode);
    await this.request(
      config,
      `/platform/v1/customers/agreement/sessions/${encodeURIComponent(input.reference)}`,
      { method: "PUT", body: { status: "SIGNED", ipAddress: input.ipAddress } }
    );
  }

  /**
   * Creates a v1 individual BVNK customer from a signed agreement session and
   * the collected PII pack.
   *
   * @param ctx - Runtime provider credentials and environment.
   * @param input - Idempotency key, the partner-supplied external reference, the
   * signed session reference, and the individual request body.
   * @returns The created customer reference and acknowledgment status.
   */
  async createCustomer(
    { env, mode }: RampRuntimeContext,
    input: CreateBvnkCustomerInput
  ): Promise<BvnkCustomerCreated> {
    const config = readBvnkConfig(env, mode);
    const response = await this.request(config, "/platform/v1/customers", {
      method: "POST",
      headers: { "X-Idempotency-Key": input.idempotencyKey },
      body: {
        type: "individual",
        externalReference: input.externalReference,
        signedAgreementSessionReference: input.signedAgreementSessionReference,
        individual: input.individual,
      },
    });
    return parseBvnkResponse(bvnkCustomerCreatedSchema, response);
  }

  /**
   * Retrieves a v1 BVNK customer, including its current verification link.
   *
   * @param ctx - Runtime provider credentials and environment.
   * @param input - BVNK customer reference (a uuid).
   * @returns The typed customer response, including verification when present.
   */
  async getCustomer(
    { env, mode }: RampRuntimeContext,
    input: { reference: string }
  ): Promise<BvnkCustomer> {
    const config = readBvnkConfig(env, mode);
    const response = await this.request(
      config,
      `/platform/v1/customers/${encodeURIComponent(input.reference)}`,
      { method: "GET" }
    );
    return parseBvnkResponse(bvnkCustomerSchema, response);
  }

  /**
   * Creates a v2 ledger wallet.
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
        ...(input.customerId === undefined ? {} : { customerId: input.customerId }),
        ...(input.profileId === undefined ? {} : { profileId: input.profileId }),
      },
    });
    return parseBvnkResponse(bvnkV2LedgerWalletSchema, response);
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
    return parseBvnkResponse(bvnkV2LedgerWalletSchema, response);
  }

  /**
   * Lists v2 ledger wallet profiles and their supported payment rails.
   *
   * @param ctx - Runtime provider credentials and environment.
   * @param input - Optional customer and currency filters.
   * @returns The paginated wallet-profile response.
   */
  async listLedgerWalletProfilesV2(
    { env, mode }: RampRuntimeContext,
    input?: ListBvnkLedgerWalletProfilesV2Input
  ): Promise<BvnkLedgerWalletProfilesV2> {
    const config = readBvnkConfig(env, mode);
    const filters = [
      input?.customerId === undefined ? undefined : `customerId:${input.customerId}`,
      input?.currency === undefined ? undefined : `currency:${input.currency}`,
    ].filter((filter): filter is string => filter !== undefined);
    const path =
      filters.length === 0
        ? "/ledger/v2/wallets/profiles"
        : `/ledger/v2/wallets/profiles?q=${encodeURIComponent(filters.join(" AND "))}`;
    const response = await this.request(config, path, { method: "GET" });
    return parseBvnkResponse(bvnkV2WalletProfilesSchema, response);
  }

  /**
   * Quotes an on-ramp payout with the dry-run endpoint before any money moves.
   * The request mirrors the create body except the network code, forced to the
   * dry-run protocol code (`BVNK_PAYOUT_NETWORK.dryRun`, `SOL`): BVNK rejects
   * the create network code here with `MER-PAY-2029`. Amount fields in the
   * response are wire numbers; convert them with `decimalStringFromNumber`
   * where a value is consumed as money.
   *
   * @param ctx - Runtime provider credentials and environment.
   * @param input - The intended payout; `input.payOutDetails.network` is
   *   ignored in favour of the dry-run protocol code.
   * @returns The dry-run quote: no uuid/status, nullable `actual` amounts.
   */
  async dryRunOnrampPayout(
    { env, mode }: RampRuntimeContext,
    input: BvnkOnrampPayoutInput
  ): Promise<BvnkDryRunPayoutResponse> {
    const config = readBvnkConfig(env, mode);
    const response = await this.request(
      config,
      "/api/v1/pay/summary/dry-run",
      { method: "POST", body: bvnkOnrampPayoutBody(input, BVNK_PAYOUT_NETWORK.dryRun) },
      bvnkPayRequestError
    );
    return parseBvnkResponse(bvnkDryRunPayoutResponseSchema, response);
  }

  /**
   * Creates an on-ramp payout from the customer's funding wallet. BVNK debits
   * the wallet at create time and dedupes on `reference` alone, so a duplicate
   * reference surfaces as {@link BvnkPayRequestError} rather than a
   * second payout. The network code is forced to `BVNK_PAYOUT_NETWORK.create`
   * (`SOLANA`).
   *
   * @param ctx - Runtime provider credentials and environment.
   * @param input - The payout request: `input.walletId` funding wallet,
   *   `input.amount` fiat amount, `input.currency` fiat currency,
   *   `input.reference` the SDP transfer id, `input.customerId` BVNK customer,
   *   `input.payOutDetails` crypto destination (code `crypto`, currency,
   *   network, address), `input.complianceDetails` requester IP and party
   *   details (required; `MER-PAY-2009` without them).
   * @returns The created payout summary, `status` PROCESSING at create.
   */
  async createOnrampPayout(
    { env, mode }: RampRuntimeContext,
    input: BvnkOnrampPayoutInput
  ): Promise<BvnkOnrampPayoutSummary> {
    const config = readBvnkConfig(env, mode);
    const response = await this.request(
      config,
      "/api/v1/pay/summary",
      { method: "POST", body: bvnkOnrampPayoutBody(input, BVNK_PAYOUT_NETWORK.create) },
      bvnkPayRequestError
    );
    return parseBvnkResponse(bvnkOnrampPayoutSummarySchema, response);
  }

  /**
   * Reads a payout by its uuid. The documented read path is
   * `/api/v1/pay/{uuid}/summary`; the bare `/api/v1/pay/{uuid}` is a 404
   * (probe step 5).
   *
   * @param ctx - Runtime provider credentials and environment.
   * @param input - `input.payoutId`: the BVNK payout uuid.
   * @returns The current payout summary for the uuid.
   */
  async getPayoutSummary(
    { env, mode }: RampRuntimeContext,
    input: { payoutId: string }
  ): Promise<BvnkOnrampPayoutSummary> {
    const config = readBvnkConfig(env, mode);
    const response = await this.request(
      config,
      `/api/v1/pay/${encodeURIComponent(input.payoutId)}/summary`,
      { method: "GET" },
      bvnkPayRequestError
    );
    return parseBvnkResponse(bvnkOnrampPayoutSummarySchema, response);
  }

  /**
   * Lists payouts by the SDP transfer-id reference on a wallet. BVNK requires
   * both `walletId` and `reference` and caps the page at `max=200`; the list
   * response is an array (empty when nothing matched, probe step 7).
   *
   * @param ctx - Runtime provider credentials and environment.
   * @param input - `input.walletId` the funding wallet, `input.reference` the
   *   transfer id used at create.
   * @returns Every payout row matching the wallet and reference.
   */
  async listPayoutsByReference(
    { env, mode }: RampRuntimeContext,
    input: { walletId: string; reference: string }
  ): Promise<BvnkOnrampPayoutSummary[]> {
    const config = readBvnkConfig(env, mode);
    const response = await this.request(
      config,
      `/api/v1/pay/summary?walletId=${encodeURIComponent(input.walletId)}&reference=${encodeURIComponent(input.reference)}&max=200`,
      { method: "GET" },
      bvnkPayRequestError
    );
    return parseBvnkResponse(z.array(bvnkOnrampPayoutSummarySchema), response);
  }

  /**
   * Lists ledger v2 wallets for one BVNK customer and fiat currency
   * (`q=customerId:<reference> AND currency:<fiat>`, the probe-proven filter
   * pair) paginating every page until exhaustion. The caller matches the
   * exact wallet name locally: SDP wallet names contain colons, which BVNK's
   * `q` grammar splits, so names are never sent into the query.
   *
   * @param ctx - Runtime provider credentials and environment.
   * @param input - `input.customerId`: the provider customer reference the
   *   wallet belongs to; `input.currency`: the wallet's fiat currency.
   * @returns Every matching wallet row across all pages, with `hasNext: false`.
   */
  async listLedgerWalletsV2(
    { env, mode }: RampRuntimeContext,
    input: { customerId: string; currency: string }
  ): Promise<BvnkV2WalletList> {
    const config = readBvnkConfig(env, mode);
    const query = encodeURIComponent(
      `customerId:${input.customerId} AND currency:${input.currency}`
    );
    let pageNumber = 0;
    let rows: BvnkV2WalletList["content"] = [];
    let hasNext = true;
    while (hasNext) {
      const response = await this.request(
        config,
        `/ledger/v2/wallets?q=${query}&pageSize=100&pageNumber=${pageNumber}`,
        { method: "GET" }
      );
      const page = parseBvnkResponse(bvnkV2WalletListSchema, response);
      rows = rows.concat(page.content);
      hasNext = page.hasNext;
      pageNumber += 1;
    }
    return { content: rows, hasNext: false };
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
      throw badRequest("BVNK sandbox pay-in simulation supports USD only.");
    }
    const config = readBvnkConfig(env, mode);
    return this.request(config, "/payment/v2/payins/simulation", {
      method: "POST",
      headers: { "Idempotency-Key": input.idempotencyKey },
      body: {
        walletId: input.walletId,
        amount: input.amount,
        currency: currency.data,
        method: SANDBOX_PAYIN_METHODS[currency.data],
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
        walletId: parsed.data.bvnkFundingWalletId,
        payCurrency: currency,
        displayCurrency: parsed.data.fiatCurrency,
        reference,
        customerId: parsed.data.externalCustomerId,
        complianceDetails: parsed.data.bvnkCompliance,
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
          instructionsNotes: `Send ${currency} on ${network} to the deposit address. BVNK converts it to ${parsed.data.fiatCurrency} and credits the counterparty's BVNK ${parsed.data.fiatCurrency} wallet.`,
        },
      ],
    };
  }
}
