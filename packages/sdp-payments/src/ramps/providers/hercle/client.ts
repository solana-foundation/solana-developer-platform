import type { SdpEnvironment } from "@sdp/types/api-keys";
import type { Counterparty } from "@sdp/types/counterparties";
import { type CryptoRailId, getCryptoRailAssetLabel } from "@sdp/types/payment-rails";
import type {
  HercleFiatFundingInstruction,
  PaymentRampEstimate,
  PaymentRampQuote,
} from "@sdp/types/payments";
import { checkRampDestination } from "@sdp/types/ramp-destinations";
import type { CounterpartyRequirements } from "@sdp/types/ramp-requirements";
import { z } from "zod";
import { subtractDecimalAmounts } from "#/decimal";
import {
  badRequest,
  internalError,
  providerUnavailable,
  SdpPaymentsError,
  type SdpPaymentsErrorCode,
} from "#/errors";
import { hmacSha256Base64 } from "#/hash";
import { type ProviderResponse, providerFetch, readProviderJson } from "#/ramps/fetch";
import { parseCollectedFields } from "#/ramps/requirements";
import {
  rampCredentials,
  UNREPORTED_COUNTRY_SUPPORT,
  unreportedCurrencyLimit,
} from "#/ramps/shared";
import type {
  ProviderDeclaredRailSupport,
  ProviderRailSupportDistillation,
  RampCustomerLink,
  RampCustomerLinkStore,
  RampDiscoveryContext,
  RampEstimateOnrampInput,
  RampKeyFormats,
  RampOnrampQuoteInput,
  RampProvider,
  RampProviderRequirements,
  RampRequirementsInput,
  RampRequirementsSubmission,
  RampRuntimeContext,
  RampSettlementEvent,
  RampTransferLookup,
  ValidateCounterpartyOptions,
} from "#/ramps/types";
import {
  HERCLE_FIELD_KEYS,
  hercleCounterpartyRequirements,
  hercleJurisdictionForCountry,
  hercleOnboardingDecision,
  hercleOnboardingFields,
  hercleSuspendedRequirements,
  hercleVerificationRequirements,
} from "./counterparty";
import {
  HERCLE_APPROVED_VERIFICATION_STATUS,
  HERCLE_SUSPENDED_ACCOUNT_STATUS,
  HERCLE_VERIFICATION_STATUSES,
  hercleSuspensionObservation,
  hercleVerdictObservation,
} from "./customer-status-mapping";
import { hercleOrderSettlementEvent, hercleOrderStatusSchema } from "./order-status-mapping";

/** The partner surface of Hercle's public API in each mode. */
const HERCLE_API_BASE_URLS = {
  sandbox: "https://publicapi.sandbox.hercle.financial",
  production: "https://publicapi.hercle.financial",
} as const satisfies Record<SdpEnvironment, string>;

const HERCLE_SECRET_KEY = /^[0-9A-Za-z]{43}$/;
/** A PEM, whose line breaks a single-line secret store may hold as literal `\n`. */
const HERCLE_WEBHOOK_PUBLIC_KEY =
  /^-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----(?:\s|\\n)*$/;

/**
 * A client id names its mode: `hpk_test_` or `hpk_live_`, then 22 base62 characters.
 * The secret (43 base62 characters) and the webhook public key do not.
 * The client id alone keeps one mode's keys out of the other.
 */
const HERCLE_KEY_FORMATS = {
  sandbox: {
    publicKey: /^hpk_test_[0-9A-Za-z]{22}$/,
    secretKey: HERCLE_SECRET_KEY,
    webhookSecret: HERCLE_WEBHOOK_PUBLIC_KEY,
  },
  production: {
    publicKey: /^hpk_live_[0-9A-Za-z]{22}$/,
    secretKey: HERCLE_SECRET_KEY,
    webhookSecret: HERCLE_WEBHOOK_PUBLIC_KEY,
  },
} as const satisfies RampKeyFormats;

export const HERCLE_DECLARED_RAIL_SUPPORT = {
  onramp: { countrySupport: UNREPORTED_COUNTRY_SUPPORT, entityTypes: ["business"] },
  offramp: { countrySupport: UNREPORTED_COUNTRY_SUPPORT, entityTypes: [] },
} as const satisfies ProviderDeclaredRailSupport;

/**
 * Declared, not fetched: the partner surface has no discovery endpoint, and limits come back on the estimate.
 * Hercle prices EUR, USD and GBP into SOL, USDC and USDT on Solana, every pair of them.
 * A pair listed here that Hercle refused would be offered by the wizard and fail at the order.
 */
const HERCLE_RAIL_SUPPORT: ProviderRailSupportDistillation = {
  snapshot: {
    onramp: {
      currencies: {
        EUR: unreportedCurrencyLimit(),
        GBP: unreportedCurrencyLimit(),
        USD: unreportedCurrencyLimit(),
      },
      cryptos: ["sol.solana", "usdc.solana", "usdt.solana"],
    },
    offramp: { currencies: {}, cryptos: [] },
  },
  droppedCurrencyCodes: [],
  droppedCountryCodes: [],
};

/** The network Hercle names every Solana rail by. */
const HERCLE_NETWORK = "solana";

/**
 * Hercle Signed Key v1: Base64(HMAC-SHA256(secret, timestamp + METHOD + pathWithQuery + rawBody)).
 * The parts are concatenated with no separators.
 */
export async function buildHercleSignature(
  secret: string,
  timestampSeconds: number,
  method: string,
  pathWithQuery: string,
  rawBody: string
): Promise<string> {
  return hmacSha256Base64(
    `${timestampSeconds}${method.toUpperCase()}${pathWithQuery}${rawBody}`,
    secret
  );
}

interface HercleRequest {
  method: "GET" | "POST";
  pathWithQuery: string;
  body?: Record<string, unknown>;
  /** The Hercle account a call acts for: the business's own account, not SDP's. */
  onBehalfOf?: string;
  idempotencyKey?: string;
}

/**
 * The fetch init for one signed call.
 * `providerFetch` sends a JSON body as `JSON.stringify` of the object.
 * Signing the same serialization signs the bytes on the wire.
 */
async function signedHercleInit(
  ctx: RampRuntimeContext,
  request: HercleRequest
): Promise<{
  url: string;
  init: { method: "GET" | "POST"; headers: Headers; body?: Record<string, unknown> };
}> {
  const { publicKey, secretKey } = rampCredentials(hercleKeyedProvider, ctx);
  const rawBody = request.body === undefined ? "" : JSON.stringify(request.body);
  const timestampSeconds = Math.floor(Date.now() / 1000);
  const headers = new Headers({
    "X-Hercle-Client": publicKey,
    "X-Hercle-Ts": String(timestampSeconds),
    "X-Hercle-Signature": await buildHercleSignature(
      secretKey,
      timestampSeconds,
      request.method,
      request.pathWithQuery,
      rawBody
    ),
  });
  if (request.onBehalfOf !== undefined) {
    headers.set("on-behalf-of", request.onBehalfOf);
  }
  if (request.idempotencyKey !== undefined) {
    headers.set("Idempotency-Key", request.idempotencyKey);
  }
  return {
    url: `${HERCLE_API_BASE_URLS[ctx.mode]}${request.pathWithQuery}`,
    init: { method: request.method, headers, body: request.body },
  };
}

/**
 * Hercle's refusals that are about the business, not SDP's keys, with the words SDP gives its caller.
 * Hercle answers them with 400, 403 or 409. The generic mapping would blame SDP's keys or report an unknown outcome.
 * Each one proves Hercle created nothing.
 */
const HERCLE_BUSINESS_REFUSALS = {
  ACCOUNT_NOT_VERIFIED: {
    code: "CONFLICT",
    message: "Hercle has not verified the business yet. Finish its verification, then quote again.",
  },
  ACCOUNT_SUSPENDED: {
    code: "CONFLICT",
    message: "Hercle has suspended the business's account.",
  },
  BANK_ACCOUNT_NOT_PROVISIONED: {
    code: "CONFLICT",
    message: "Hercle is still opening the business's bank account. Quote again later.",
  },
  CORRIDOR_NOT_SUPPORTED: {
    code: "BAD_REQUEST",
    message: "Hercle does not offer this currency pair.",
  },
} as const satisfies Record<string, { code: SdpPaymentsErrorCode; message: string }>;

function isHercleBusinessRefusal(code: string): code is keyof typeof HERCLE_BUSINESS_REFUSALS {
  return Object.hasOwn(HERCLE_BUSINESS_REFUSALS, code);
}

/** Hercle's error envelope, read only for its machine code. */
const hercleErrorCodeSchema = z.object({ code: z.string() });

/** The code of a Hercle refusal, or undefined for a success or a body without one. */
function hercleRefusalCode(answer: ProviderResponse): string | undefined {
  if (answer.response.ok) {
    return undefined;
  }
  const refusal = hercleErrorCodeSchema.safeParse(answer.parsed);
  return refusal.success ? refusal.data.code : undefined;
}

/**
 * Reads a Hercle answer as `readProviderJson` does, first naming a refusal that is about the business.
 *
 * @param diagnostics - What the API logs with a refusal of the business, and never returns.
 */
function readHercleAnswer<TSchema extends z.ZodType>(
  answer: ProviderResponse,
  schema: TSchema,
  diagnostics?: Record<string, unknown>
): z.output<TSchema> {
  const code = hercleRefusalCode(answer);
  if (code !== undefined && isHercleBusinessRefusal(code)) {
    const refusal = HERCLE_BUSINESS_REFUSALS[code];
    throw new SdpPaymentsError(
      refusal.code,
      refusal.message,
      { provider: "hercle", providerStatus: answer.response.status, outcome: "rejected" },
      diagnostics
    );
  }
  return readProviderJson("hercle", answer, schema);
}

async function hercleRequest<TSchema extends z.ZodType>(
  ctx: RampRuntimeContext,
  request: HercleRequest,
  schema: TSchema
): Promise<z.output<TSchema>> {
  const { url, init } = await signedHercleInit(ctx, request);
  return readHercleAnswer(await providerFetch("hercle", url, init), schema);
}

const hercleAmountSchema = z.string().regex(/^\d+(\.\d+)?$/);

const hercleEstimateSchema = z.object({
  fiatAmount: hercleAmountSchema,
  cryptoAmount: hercleAmountSchema,
  exchangeRate: hercleAmountSchema,
  fees: z.object({ total: hercleAmountSchema }),
  minFiatAmount: hercleAmountSchema.optional(),
  maxFiatAmount: hercleAmountSchema.optional(),
});

/** An optional bank identity field: Hercle may send it blank, which reads as absent. */
const hercleBankTextSchema = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value.trim() === "" ? undefined : value.trim()));

/**
 * The account attributes the wire to the business, and the reference attributes it to this order.
 * The payer is the first-party name the bank enforces.
 * An order missing any of them cannot be funded, matched or wired from the right account.
 * It is refused as unreadable rather than handed to the business as instructions it cannot act on.
 */
const hercleOnrampOrderSchema = z.object({
  orderId: z.string().trim().min(1),
  fiatCurrency: z.string().trim().min(1),
  fiatAmount: hercleAmountSchema,
  bankAccount: z.object({
    iban: z.string().trim().min(1),
    bic: hercleBankTextSchema,
    bankName: hercleBankTextSchema,
    accountHolder: hercleBankTextSchema,
    paymentReference: z.string().trim().min(1),
    payerAccountHolder: z.string().trim().min(1),
  }),
  expiresAt: z.string().optional(),
});

const hercleAccountSchema = z.object({ accountId: z.string().trim().min(1) });

const hercleAccountByReferenceSchema = z.object({
  accountId: z.string().trim().min(1),
  externalReference: z.string(),
});

/**
 * The part of `GET /partner/v1/accounts/{id}` that shows a suspension.
 * Hercle's order gate reads a suspension from `financialStatus` alone, compared without regard to case.
 */
const hercleAccountStandingSchema = z.object({
  accountId: z.string().trim().min(1),
  financialStatus: z.string().nullish(),
});

const HERCLE_SUSPENDED_FINANCIAL_STATUS = "suspended";

/** The conflicts Hercle answers when it already holds an account under SDP's idempotency key or the business's reference. */
const HERCLE_ACCOUNT_EXISTS_CODES: ReadonlySet<string> = new Set([
  "IDEMPOTENCY_KEY_REUSED",
  "REF_CONFLICT",
]);

const hercleVerificationSchema = z.object({
  status: z.enum(HERCLE_VERIFICATION_STATUSES),
  verificationUrl: z.string().optional(),
});

/** The simulation's answer: SDP reads none of it, since the webhook it triggers carries the outcome. */
const hercleSimulatedSettlementSchema = z.object({});

/** The part of the client its key checks read, so request signing needs no instance. */
const hercleKeyedProvider = { label: "Hercle", keyFormats: HERCLE_KEY_FORMATS } as const;

/**
 * The idempotency key of the business's account, one per counterparty.
 * A retried submission replays the account instead of opening a second, and the verification key below does the same.
 */
function hercleAccountIdempotencyKey(counterparty: Counterparty): string {
  return `sdp-account-${counterparty.id}`;
}

function hercleVerificationIdempotencyKey(counterparty: Counterparty): string {
  return `sdp-kyb-${counterparty.id}`;
}

function hercleAccountPath(accountId: string, suffix: string): string {
  return `/partner/v1/accounts/${encodeURIComponent(accountId)}/${suffix}`;
}

type HercleVerification = z.output<typeof hercleVerificationSchema>;

/** The code Hercle answers a verdict read with while the business's verification has not started. */
const HERCLE_VERIFICATION_NOT_STARTED = "VERIFICATION_NOT_STARTED";

/** Refuses a hosted link outside the destinations SDP sends a user to. */
function trustedHercleVerification(verification: HercleVerification): HercleVerification {
  if (verification.verificationUrl !== undefined) {
    const destination = checkRampDestination(verification.verificationUrl, null);
    if (!destination.ok) {
      throw providerUnavailable("Hercle returned an untrusted verification link.", {
        provider: "hercle",
        reason: destination.reason,
      });
    }
  }
  return verification;
}

/** When SDP sends a read, which orders Hercle's answer against Hercle's events and SDP's other reads. */
function hercleAskedAt(): string {
  return new Date().toISOString();
}

/**
 * Starts the linked business's verification.
 * Hercle replays the start it already holds under the same key, so a retried submission resumes the same verification.
 */
async function startHercleVerification(
  ctx: RampRuntimeContext,
  counterparty: Counterparty,
  accountId: string
): Promise<HercleVerification> {
  return trustedHercleVerification(
    await hercleRequest(
      ctx,
      {
        method: "POST",
        pathWithQuery: hercleAccountPath(accountId, "verifications"),
        body: {},
        idempotencyKey: hercleVerificationIdempotencyKey(counterparty),
      },
      hercleVerificationSchema
    )
  );
}

/**
 * Hercle's current verdict on the linked business, or null while its verification has not started.
 * It only reads, so a requirements read never asks Hercle to act.
 */
async function readStartedHercleVerification(
  ctx: RampRuntimeContext,
  accountId: string
): Promise<HercleVerification | null> {
  const { url, init } = await signedHercleInit(ctx, {
    method: "GET",
    pathWithQuery: hercleAccountPath(accountId, "verification"),
  });
  const answer = await providerFetch("hercle", url, init);
  if (
    answer.response.status === 404 &&
    hercleRefusalCode(answer) === HERCLE_VERIFICATION_NOT_STARTED
  ) {
    return null;
  }
  return trustedHercleVerification(readHercleAnswer(answer, hercleVerificationSchema));
}

/**
 * Whether Hercle has suspended the business's financial operations, read from its account.
 *
 * @throws SdpPaymentsError PROVIDER_RESPONSE_INVALID when Hercle answers with another account.
 */
async function isHercleAccountSuspended(
  ctx: RampRuntimeContext,
  accountId: string
): Promise<boolean> {
  const account = await hercleRequest(
    ctx,
    { method: "GET", pathWithQuery: `/partner/v1/accounts/${encodeURIComponent(accountId)}` },
    hercleAccountStandingSchema
  );
  if (account.accountId !== accountId) {
    throw new SdpPaymentsError("PROVIDER_RESPONSE_INVALID", "hercle returned another account", {
      provider: "hercle",
      outcome: "unknown",
    });
  }
  return account.financialStatus?.toLowerCase() === HERCLE_SUSPENDED_FINANCIAL_STATUS;
}

/**
 * Records Hercle's verdict on the link, which the quote gate reads, and answers for it.
 * Every read is recorded, so it also outdates any older Hercle event still waiting to be applied.
 */
async function answerHercleVerification(
  input: RampRequirementsInput,
  verification: HercleVerification,
  observedAt: string,
  accountActive: boolean
): Promise<CounterpartyRequirements> {
  await input.customerLink.recordStatus(
    hercleVerdictObservation(verification.status, observedAt, accountActive)
  );
  return hercleVerificationRequirements(verification, input.direction);
}

/**
 * The answer for a business SDP last saw suspended.
 * Only Hercle's account read shows a suspension, so it comes first.
 * Once Hercle has lifted the suspension, the verdict read after it replaces the suspension on the link.
 *
 * @param startIfNone - Whether to start the verification when Hercle holds none, as a submission does.
 */
async function answerSuspendedHercleBusiness(
  ctx: RampRuntimeContext,
  input: RampRequirementsInput,
  link: RampCustomerLink,
  startIfNone: boolean
): Promise<CounterpartyRequirements> {
  const accountId = link.providerCustomerReference;
  const accountObservedAt = hercleAskedAt();
  if (await isHercleAccountSuspended(ctx, accountId)) {
    await input.customerLink.recordStatus(hercleSuspensionObservation(accountObservedAt));
    return hercleSuspendedRequirements(input.direction);
  }
  const observedAt = hercleAskedAt();
  const read = await readStartedHercleVerification(ctx, accountId);
  const verification =
    read === null && startIfNone
      ? await startHercleVerification(ctx, input.counterparty, accountId)
      : read;
  if (verification === null) {
    await input.customerLink.recordStatus(hercleVerdictObservation(null, observedAt, true));
    return hercleOnboardingDecision(input.counterparty, input.direction, false);
  }
  return answerHercleVerification(input, verification, observedAt, true);
}

/**
 * Records on the link what Hercle's refusal of an order shows about the business.
 * A suspension is the refusal's own news.
 * A refusal for want of verification does not name the verdict, so the verdict is read again.
 * That refusal also shows the account is not suspended, because Hercle reports a suspension first.
 *
 * @returns Why the link could not be corrected, for the refusal's diagnostics.
 * The next refusal or requirements read corrects it.
 */
async function recordHercleOrderRefusal(
  ctx: RampRuntimeContext,
  customerLink: RampCustomerLinkStore,
  accountId: string,
  refusalCode: string | undefined,
  orderObservedAt: string
): Promise<Record<string, unknown> | undefined> {
  try {
    switch (refusalCode) {
      case "ACCOUNT_SUSPENDED":
        await customerLink.recordStatus(hercleSuspensionObservation(orderObservedAt));
        return undefined;
      case "ACCOUNT_NOT_VERIFIED": {
        const observedAt = hercleAskedAt();
        const verification = await readStartedHercleVerification(ctx, accountId);
        await customerLink.recordStatus(
          hercleVerdictObservation(
            verification === null ? null : verification.status,
            observedAt,
            true
          )
        );
        return undefined;
      }
      default:
        return undefined;
    }
  } catch (cause) {
    return { customerLinkRecheckFailed: cause instanceof Error ? cause.message : String(cause) };
  }
}

/**
 * The KYB fields as `parseCollectedFields` leaves them, once `hercleOnboardingFields` has checked each one.
 * The country field offers only Hercle's perimeter, so it always has a jurisdiction.
 */
const hercleCollectedKybSchema = z.object({
  [HERCLE_FIELD_KEYS.legalName]: z.string(),
  [HERCLE_FIELD_KEYS.registrationNumber]: z.string(),
  [HERCLE_FIELD_KEYS.registrationCountry]: z.string(),
  [HERCLE_FIELD_KEYS.addressLine1]: z.string(),
  [HERCLE_FIELD_KEYS.addressCity]: z.string(),
  [HERCLE_FIELD_KEYS.addressPostalCode]: z.string(),
});

/**
 * The account Hercle already holds for the business, found by the reference SDP opened it under.
 *
 * @throws SdpPaymentsError PROVIDER_RESPONSE_INVALID when Hercle answers with another business's account.
 */
async function findHercleAccount(
  ctx: RampRuntimeContext,
  counterparty: Counterparty
): Promise<string> {
  const account = await hercleRequest(
    ctx,
    {
      method: "GET",
      pathWithQuery: `/partner/v1/accounts?externalReference=${encodeURIComponent(counterparty.id)}`,
    },
    hercleAccountByReferenceSchema
  );
  if (account.externalReference !== counterparty.id) {
    throw new SdpPaymentsError("PROVIDER_RESPONSE_INVALID", "hercle returned another account", {
      provider: "hercle",
      outcome: "unknown",
    });
  }
  return account.accountId;
}

/**
 * Opens the business's Hercle account from the collected KYB fields and links it.
 * The fields and the consents go to Hercle and nowhere else.
 * When Hercle opened the account but SDP never stored the answer, a re-sent submission that changed a field conflicts.
 * SDP then links the account Hercle holds, which keeps the details of the first submission.
 */
async function openHercleAccount(
  ctx: RampRuntimeContext,
  input: RampRequirementsSubmission
): Promise<RampCustomerLink> {
  const kyb = hercleCollectedKybSchema.parse(
    parseCollectedFields(
      hercleOnboardingFields(),
      input.collectedData,
      "Hercle needs the business's registration details and its acceptance of Hercle's terms."
    )
  );
  const country = kyb[HERCLE_FIELD_KEYS.registrationCountry];
  const jurisdiction = hercleJurisdictionForCountry(country);
  if (jurisdiction === undefined) {
    throw internalError("The Hercle country field offered a country outside Hercle's perimeter.");
  }
  const { url, init } = await signedHercleInit(ctx, {
    method: "POST",
    pathWithQuery: "/partner/v1/accounts",
    // `accountType` is explicit, so a change to Hercle's default for a blank one never reclassifies SDP's businesses.
    // No `accountLabel`: SDP never reads it back, and Hercle plans to repurpose it.
    body: {
      accountType: "BUSINESS",
      companyName: kyb[HERCLE_FIELD_KEYS.legalName],
      registrationNumber: kyb[HERCLE_FIELD_KEYS.registrationNumber],
      registeredAddress: {
        line1: kyb[HERCLE_FIELD_KEYS.addressLine1],
        city: kyb[HERCLE_FIELD_KEYS.addressCity],
        postalCode: kyb[HERCLE_FIELD_KEYS.addressPostalCode],
        country,
      },
      jurisdiction,
      fundingMode: "Funded",
      externalReference: input.counterparty.id,
      // The collect step carries the consents without a time.
      // The earliest instant SDP can attest them is now, when it hands them to Hercle.
      consents: {
        termsAndConditions: true,
        privacyPolicy: true,
        acceptedAt: new Date().toISOString(),
      },
    },
    idempotencyKey: hercleAccountIdempotencyKey(input.counterparty),
  });
  const answer = await providerFetch("hercle", url, init);
  const refusalCode = answer.response.status === 409 ? hercleRefusalCode(answer) : undefined;
  if (refusalCode !== undefined && HERCLE_ACCOUNT_EXISTS_CODES.has(refusalCode)) {
    return input.customerLink.link(await findHercleAccount(ctx, input.counterparty));
  }
  const account = readHercleAnswer(answer, hercleAccountSchema);
  return input.customerLink.link(account.accountId);
}

const HERCLE_REQUIREMENTS: RampProviderRequirements = {
  async describe(ctx, input) {
    const link = await input.customerLink.read();
    const decision = hercleOnboardingDecision(input.counterparty, input.direction, link !== null);
    if (link === null || decision.status !== "ready") {
      return decision;
    }
    if (link.providerStatus === HERCLE_APPROVED_VERIFICATION_STATUS) {
      return decision;
    }
    if (link.providerStatus === HERCLE_SUSPENDED_ACCOUNT_STATUS) {
      return answerSuspendedHercleBusiness(ctx, input, link, false);
    }
    const observedAt = hercleAskedAt();
    const verification = await readStartedHercleVerification(ctx, link.providerCustomerReference);
    if (verification === null) {
      // The submission that opened the account stopped before its verification started.
      // Asking for the fields again lets the next submission start it.
      return hercleOnboardingDecision(input.counterparty, input.direction, false);
    }
    return answerHercleVerification(input, verification, observedAt, false);
  },

  async submit(ctx, input) {
    const existing = await input.customerLink.read();
    const decision = hercleOnboardingDecision(
      input.counterparty,
      input.direction,
      existing !== null
    );
    if (decision.status === "unsupported") {
      return decision;
    }
    const link = existing === null ? await openHercleAccount(ctx, input) : existing;
    if (link.providerStatus === HERCLE_APPROVED_VERIFICATION_STATUS) {
      return hercleVerificationRequirements({ status: link.providerStatus }, input.direction);
    }
    if (link.providerStatus === HERCLE_SUSPENDED_ACCOUNT_STATUS) {
      return answerSuspendedHercleBusiness(ctx, input, link, true);
    }
    // A link with no recorded verdict starts verification, which replays an earlier start.
    // One with a verdict reads it, and starts verification only if Hercle holds none.
    const accountId = link.providerCustomerReference;
    const observedAt = hercleAskedAt();
    const verification =
      link.providerStatus === null
        ? await startHercleVerification(ctx, input.counterparty, accountId)
        : ((await readStartedHercleVerification(ctx, accountId)) ??
          (await startHercleVerification(ctx, input.counterparty, accountId)));
    return answerHercleVerification(input, verification, observedAt, false);
  },

  isCustomerReady(link) {
    return link.providerStatus === HERCLE_APPROVED_VERIFICATION_STATUS;
  },
};

/** The asset Hercle prices a rail's crypto as, on its one network. */
function hercleAsset(assetRail: CryptoRailId): { cryptoAsset: string; network: string } {
  return { cryptoAsset: getCryptoRailAssetLabel(assetRail), network: HERCLE_NETWORK };
}

/**
 * Hercle: a headless fiat on-ramp for businesses.
 * Each business is a Hercle account SDP opens and verifies through the requirements member.
 * Every order runs on SDP's partner keys acting for that account.
 * There is no off-ramp, so the client has no off-ramp members.
 */
export class HercleRampClient implements RampProvider {
  readonly id = "hercle";
  readonly label = hercleKeyedProvider.label;
  readonly declaredRailSupport = HERCLE_DECLARED_RAIL_SUPPORT;
  readonly keyFormats = HERCLE_KEY_FORMATS;
  readonly requirements = HERCLE_REQUIREMENTS;

  async discoverCurrencyAndRails(
    _context: RampDiscoveryContext
  ): Promise<ProviderRailSupportDistillation> {
    return HERCLE_RAIL_SUPPORT;
  }

  validateCounterparty(
    counterparty: Counterparty,
    options: ValidateCounterpartyOptions
  ): CounterpartyRequirements {
    return hercleCounterpartyRequirements(counterparty, options);
  }

  /**
   * Hercle takes its fee out of the fiat paid in, so the fiat that buys the crypto is the rest.
   * The estimate's `expiresAt` is the price feed's RFQ window, seconds long. Hercle prices the order again when it opens.
   * It promises nothing the business can act on, so it is left out and the review shows no countdown that lapses on screen.
   */
  async estimateOnramp(
    ctx: RampRuntimeContext,
    input: RampEstimateOnrampInput
  ): Promise<PaymentRampEstimate> {
    const estimate = await hercleRequest(
      ctx,
      {
        method: "POST",
        pathWithQuery: "/partner/v1/quotes/estimate",
        body: {
          direction: "onramp",
          fiatCurrency: input.fiatCurrency,
          fiatAmount: input.fiatAmount,
          ...hercleAsset(input.assetRail),
        },
      },
      hercleEstimateSchema
    );
    return {
      provider: this.id,
      direction: "onramp",
      fiatCurrency: input.fiatCurrency,
      assetRail: input.assetRail,
      fiatAmount: subtractDecimalAmounts(estimate.fiatAmount, estimate.fees.total),
      cryptoAmount: estimate.cryptoAmount,
      exchangeRate: estimate.exchangeRate,
      totalFiatAmount: estimate.fiatAmount,
      fees: { currency: input.fiatCurrency, total: estimate.fees.total },
      minFiatAmount: estimate.minFiatAmount,
      maxFiatAmount: estimate.maxFiatAmount,
    };
  }

  /**
   * The quote is the order: Hercle answers with the bank account and reference the business wires to.
   * It is keyed on SDP's transfer id, so two orders for the same amount never collapse into one.
   * A refusal of the business corrects the link the quote gate read, so a revocation SDP missed stops the next quote.
   */
  async createOnrampQuote(
    ctx: RampRuntimeContext,
    input: RampOnrampQuoteInput
  ): Promise<PaymentRampQuote> {
    if (input.fiatCurrency === undefined) {
      throw badRequest("Hercle on-ramp requires a fiat currency.", { provider: this.id });
    }
    if (input.paymentTransferId === undefined) {
      throw internalError("A Hercle order requires the reserved transfer id.", {
        provider: this.id,
      });
    }
    const orderObservedAt = hercleAskedAt();
    const { url, init } = await signedHercleInit(ctx, {
      method: "POST",
      pathWithQuery: "/partner/v1/orders/onramp",
      body: {
        fiatCurrency: input.fiatCurrency,
        fiatAmount: input.fiatAmount,
        ...hercleAsset(input.assetRail),
        destinationWalletAddress: input.destinationWalletAddress,
      },
      onBehalfOf: input.externalCustomerId,
      idempotencyKey: `sdp-onramp-${input.paymentTransferId}`,
    });
    const answer = await providerFetch(this.id, url, init);
    const recheckFailure =
      input.customerLink === undefined
        ? undefined
        : await recordHercleOrderRefusal(
            ctx,
            input.customerLink,
            input.externalCustomerId,
            hercleRefusalCode(answer),
            orderObservedAt
          );
    const order = readHercleAnswer(answer, hercleOnrampOrderSchema, recheckFailure);
    const instruction: HercleFiatFundingInstruction = {
      provider: "hercle",
      kind: "fiat_funding",
      fiatCurrency: order.fiatCurrency,
      bankAccount: order.bankAccount,
      instructionsNotes: `Wire ${order.fiatAmount} ${order.fiatCurrency} from a bank account held by ${order.bankAccount.payerAccountHolder}, and include the payment reference. The bank returns a wire from any other account.`,
    };
    return {
      provider: "hercle",
      id: order.orderId,
      status: "pending",
      deliveryMode: "manual_instructions",
      paymentInstructions: [instruction],
      expiresAt: order.expiresAt,
    };
  }

  /**
   * Hercle's sandbox settles an order only through this call.
   * Hercle applies the outcome the bank rail would report and sends the same signed webhook a real wire produces.
   */
  async simulateSandboxSettlement(ctx: RampRuntimeContext, orderId: string): Promise<void> {
    if (ctx.mode !== "sandbox") {
      throw badRequest("Hercle settles orders by simulation in sandbox only.", {
        provider: this.id,
      });
    }
    await hercleRequest(
      ctx,
      {
        method: "POST",
        pathWithQuery: `/partner/v1/orders/${encodeURIComponent(orderId)}/simulate-settlement`,
        body: { status: "settled" },
      },
      hercleSimulatedSettlementSchema
    );
  }

  /**
   * One request: the order the transfer was quoted with.
   * Hercle answers an order it does not hold with its ORDER_NOT_FOUND envelope, which reads as none.
   * A bare 404 means its ramp surface is off, which is a failure to ask, not an answer.
   */
  async fetchTransferStatus(
    ctx: RampRuntimeContext,
    lookup: RampTransferLookup
  ): Promise<readonly RampSettlementEvent[]> {
    if (lookup.rampType !== "onramp") {
      throw badRequest("Hercle off-ramp is not supported.", { provider: this.id });
    }
    const orderId = lookup.providerReference;
    if (orderId === null) {
      throw internalError("A Hercle status lookup requires the order id.", { provider: this.id });
    }
    const { url, init } = await signedHercleInit(ctx, {
      method: "GET",
      pathWithQuery: `/partner/v1/orders/${encodeURIComponent(orderId)}`,
    });
    const answer = await providerFetch(this.id, url, init);
    if (answer.response.status === 404 && hercleRefusalCode(answer) === "ORDER_NOT_FOUND") {
      return [];
    }
    const order = readHercleAnswer(answer, hercleOrderStatusSchema);
    if (order.orderId !== orderId) {
      throw new SdpPaymentsError("PROVIDER_RESPONSE_INVALID", "hercle returned another order", {
        provider: this.id,
        outcome: "unknown",
      });
    }
    return [hercleOrderSettlementEvent(order)];
  }
}
