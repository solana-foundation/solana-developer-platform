import {
  OFFRAMP_SUPPORT,
  ONRAMP_SUPPORT,
  type PaymentRampEstimate,
  type PaymentRampQuote,
  RAMP_PROVIDERS,
  type RampFiatCurrency,
  type RampProviderEstimateResult,
  type RampProviderId,
} from "@sdp/types";
import { type CryptoRailId, getCryptoRailAssetLabel } from "@sdp/types/payment-rails";
import type {
  CounterpartyRequirements,
  PayoutRequirementAccount,
  PayoutRequirementTree,
  RequirementField,
  RequirementOption,
} from "@sdp/types/ramp-requirements";
import type { Address } from "@solana/kit";
import { z } from "zod";
import { getRampProviderLabel } from "../ramps";
import {
  DEMO_TOKENS,
  type DemoWorld,
  findWallet,
  fromBaseUnits,
  MINUTE_MS,
  symbolForMint,
  toBaseUnits,
} from "./demo-fixtures";
import { type DemoOp, newDemoId } from "./demo-ops";
import {
  accountById,
  consentKey,
  contactById,
  DEMO_BATCH_RECIPIENTS_PER_TRANSACTION,
  mintForRail,
  rampDepositAddress,
  rampReference,
  tokenKeyForMint,
  transferById,
  walletHolding,
} from "./demo-replay";

/*
 * What the demo answers for the writes and mid-flow reads the Payments screens make: the same
 * envelopes the SDP API sends, after the checks it would run, so a demo walks every flow to its
 * last screen. A write records its action for the session (see demo-mode.ts); the answer is read
 * from the world with that action applied.
 */

export interface DemoAnswer {
  status: number;
  body?: unknown;
}

export interface DemoWriteResult {
  ops: DemoOp[];
  answer: (world: DemoWorld) => DemoAnswer;
}

interface WriteContext {
  segments: readonly string[];
  body: unknown;
  world: DemoWorld;
  ops: readonly DemoOp[];
  now: Date;
}

/** The provider whose payouts go to a contact's saved bank account. */
const PAYOUT_ACCOUNT_PROVIDER = "lightspark";

const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DECIMAL = /^\d+(\.\d+)?$/;

const amountSchema = z
  .string()
  .trim()
  .regex(DECIMAL, "Enter an amount, like 25.00.")
  .refine((value) => Number(value) > 0, "Enter an amount greater than zero.");
const addressSchema = z.string().trim().regex(SOLANA_ADDRESS, "Enter a valid Solana address.");

function ok(body: unknown, status = 200): DemoAnswer {
  return { status, body };
}

function error(status: number, message: string, code = "invalid_request"): DemoWriteResult {
  return { ops: [], answer: () => ({ status, body: { error: { code, message } } }) };
}

function record(ops: DemoOp[], answer: (world: DemoWorld) => DemoAnswer): DemoWriteResult {
  return { ops, answer };
}

function parse<T>(schema: z.ZodType<T>, body: unknown): { data: T } | { failure: DemoWriteResult } {
  const parsed = schema.safeParse(body);
  if (parsed.success) return { data: parsed.data };
  const issue = parsed.error.issues[0];
  const field = issue?.path.join(".");
  return {
    failure: error(
      400,
      issue ? `${field ? `${field}: ` : ""}${issue.message}` : "The request is not valid."
    ),
  };
}

function tokenSymbol(mint: string): string {
  return symbolForMint(mint) ?? "tokens";
}

/** Null when the wallet holds enough of the token; otherwise why it cannot pay. */
function shortfall(world: DemoWorld, walletId: string, mint: string, amount: string) {
  const wallet = findWallet(world, walletId);
  const key = tokenKeyForMint(mint);
  if (!wallet) return "That wallet is not in this project.";
  if (!key) return "The demo wallets don't hold that token.";
  const { decimals } = DEMO_TOKENS[key];
  const held = walletHolding(wallet, mint);
  if (toBaseUnits(held, decimals) >= toBaseUnits(amount, decimals)) return null;
  return `Not enough ${tokenSymbol(mint)} in ${wallet.label ?? "this wallet"}: ${held} available.`;
}

function scaled(value: number, decimals: number): string {
  return value.toFixed(decimals);
}

// ─── Contacts ────────────────────────────────────────────────────────────────

const createContactSchema = z.object({
  entityType: z.enum(["individual", "business"]),
  displayName: z.string().trim().min(1, "Enter a name.").max(120),
  externalId: z.string().trim().max(120).nullish(),
});

function createContact({ body, world, now }: WriteContext): DemoWriteResult {
  const input = parse(createContactSchema, body);
  if ("failure" in input) return input.failure;
  const externalId = input.data.externalId || null;
  if (
    externalId !== null &&
    Object.values(world.contacts).some((contact) => contact.externalId === externalId)
  ) {
    return error(409, "A contact with that external ID already exists.", "conflict");
  }
  const id = newDemoId("cpty");
  return record(
    [
      {
        k: "contact",
        id,
        at: now.getTime(),
        name: input.data.displayName,
        entity: input.data.entityType,
        ext: externalId,
      },
    ],
    (after) => ok({ data: { counterparty: contactById(after, id) } }, 201)
  );
}

function archiveContact({ segments, world, now }: WriteContext): DemoWriteResult {
  const id = segments[1] ?? "";
  if (!contactById(world, id)) return error(404, "Contact not found.", "not_found");
  return record([{ k: "contact-archive", id, at: now.getTime() }], () => ({ status: 204 }));
}

const createAccountSchema = z.object({
  accountKind: z.literal("crypto_wallet"),
  label: z.string().trim().max(120).nullish(),
  details: z.object({ network: z.string().optional(), address: addressSchema }),
});

function createAccount({ segments, body, world, now }: WriteContext): DemoWriteResult {
  const counterpartyId = segments[1] ?? "";
  const contact = contactById(world, counterpartyId);
  if (!contact) return error(404, "Contact not found.", "not_found");
  const input = parse(createAccountSchema, body);
  if ("failure" in input) return input.failure;
  const address = input.data.details.address;
  const duplicate = Object.values(world.accounts).some(
    (account) => account.counterpartyId === counterpartyId && account.details.address === address
  );
  if (duplicate) {
    return error(409, `This address is already saved for ${contact.displayName}.`, "conflict");
  }
  const id = newDemoId("cpa");
  return record(
    [
      {
        k: "address",
        id,
        at: now.getTime(),
        cp: counterpartyId,
        address,
        label: input.data.label || null,
      },
    ],
    (after) => ok({ data: { account: accountById(after, id) } }, 201)
  );
}

// ─── Compliance ──────────────────────────────────────────────────────────────

const screeningSchema = z.object({ address: addressSchema });

function screenAddress({ body, now }: WriteContext): DemoWriteResult {
  const input = parse(screeningSchema, body);
  if ("failure" in input) return input.failure;
  const evaluatedAt = now.toISOString();
  return record([], () =>
    ok({
      data: {
        screening: {
          checkedAt: evaluatedAt,
          providers: [
            { provider: "range", status: "ok", riskScore: 1, riskLevel: "low", evaluatedAt },
          ],
        },
      },
    })
  );
}

// ─── Ramps: requirements ─────────────────────────────────────────────────────

interface Corridor {
  country: string;
  rails: RequirementOption[];
}

/** A rail as the provider lists it, value and English name (the API's own language). */
function rail(value: string, name = value): RequirementOption {
  return { value, label: name };
}

/** A bank detail the provider asks for, with the pattern it checks. */
function bankField(key: string, name: string, pattern?: string): RequirementField {
  return { kind: "text", key, label: name, required: true, ...(pattern ? { pattern } : {}) };
}

const PAYOUT_CORRIDORS: Record<string, Corridor[]> = {
  USD: [{ country: "US", rails: [rail("ACH"), rail("WIRE", "Wire")] }],
  EUR: [
    { country: "DE", rails: [rail("SEPA")] },
    { country: "FR", rails: [rail("SEPA")] },
    { country: "IE", rails: [rail("SEPA")] },
  ],
  GBP: [{ country: "GB", rails: [rail("FPS", "Faster Payments")] }],
};

const BANK_NAME_FIELD = bankField("bankName", "Bank name");
const US_ACCOUNT_FIELDS = [
  BANK_NAME_FIELD,
  bankField("accountNumber", "Account number", "^\\d{4,17}$"),
  bankField("routingNumber", "Routing number", "^\\d{9}$"),
];

const RAIL_FIELDS: Record<string, RequirementField[]> = {
  ACH: US_ACCOUNT_FIELDS,
  WIRE: US_ACCOUNT_FIELDS,
  SEPA: [BANK_NAME_FIELD, bankField("iban", "IBAN", "^[A-Z]{2}\\d{2}[A-Z0-9]{10,30}$")],
  FPS: [
    BANK_NAME_FIELD,
    bankField("accountNumber", "Account number", "^\\d{8}$"),
    bankField("sortCode", "Sort code", "^\\d{6}$"),
  ],
};

function corridorsFor(fiatCurrency: string): Corridor[] {
  return PAYOUT_CORRIDORS[fiatCurrency] ?? PAYOUT_CORRIDORS.USD ?? [];
}

function savedPayoutAccounts(
  world: DemoWorld,
  counterpartyId: string,
  fiatCurrency: string
): PayoutRequirementAccount[] {
  return world.providerAccounts
    .filter(
      (entry) =>
        entry.counterpartyId === counterpartyId &&
        entry.account.provider === PAYOUT_ACCOUNT_PROVIDER &&
        entry.account.fiatCurrency === fiatCurrency &&
        entry.account.destinationCountry !== null
    )
    .map(({ account }) => ({
      id: account.id,
      destinationCountry:
        account.destinationCountry as PayoutRequirementAccount["destinationCountry"],
      paymentRail: account.paymentRail,
      status: "ACTIVE",
      ...(account.bankName ? { bankName: account.bankName } : {}),
      ...(account.accountNumberLast4 ? { accountNumberLast4: account.accountNumberLast4 } : {}),
    }));
}

function payoutTree(
  world: DemoWorld,
  counterpartyId: string,
  fiatCurrency: string
): PayoutRequirementTree {
  const corridors = corridorsFor(fiatCurrency);
  const rails = new Set(corridors.flatMap((corridor) => corridor.rails.map((rail) => rail.value)));
  return {
    countryRails: Object.fromEntries(
      corridors.map((corridor) => [corridor.country, corridor.rails])
    ) as PayoutRequirementTree["countryRails"],
    railFields: Object.fromEntries(
      [...rails].map((rail) => [rail, RAIL_FIELDS[rail] ?? [BANK_NAME_FIELD]])
    ),
    accounts: savedPayoutAccounts(world, counterpartyId, fiatCurrency),
  };
}

function isRampProvider(value: string): value is RampProviderId {
  return (RAMP_PROVIDERS as readonly string[]).includes(value);
}

/**
 * BVNK's agreements, as it asks a contact to accept them before its first ramp. The links are
 * BVNK's public legal pages, which the consent step only offers to open.
 */
function bvnkAgreement(name: string, displayName: string, description: string, page: string) {
  return {
    name,
    displayName,
    description,
    url: `https://www.bvnk.com/legal/${page}`,
    privacyPolicyUrl: "https://www.bvnk.com/legal/privacy-policy",
  };
}

const BVNK_AGREEMENTS = [
  bvnkAgreement(
    "bvnk_terms_of_service",
    "BVNK Terms of Service",
    "How BVNK holds, converts and pays out funds for this contact.",
    "terms-of-service"
  ),
];

function bvnkAgreements(direction: "onramp" | "offramp"): CounterpartyRequirements {
  return {
    provider: "bvnk",
    direction,
    status: "counterparty_collect_agreement",
    agreements: BVNK_AGREEMENTS,
  };
}

/**
 * Where a demo contact stands with a ramp provider. Most are ready at once; BVNK first asks the
 * contact to accept its agreements; a Lightspark payout asks which bank account to pay, offering
 * the ones saved and a form for a new one.
 */
function requirementsFor(
  world: DemoWorld,
  counterpartyId: string,
  params: URLSearchParams
): CounterpartyRequirements {
  const provider = params.get("provider") ?? PAYOUT_ACCOUNT_PROVIDER;
  const direction = params.get("direction") === "offramp" ? "offramp" : "onramp";
  if (!isRampProvider(provider)) {
    return {
      provider: PAYOUT_ACCOUNT_PROVIDER,
      direction,
      status: "unsupported",
      reason: "That provider isn't part of the demo.",
    };
  }
  if (provider === "bvnk" && !world.consents.includes(consentKey(provider, counterpartyId))) {
    return bvnkAgreements(direction);
  }
  if (provider !== "lightspark") return { provider, direction, status: "ready" };
  if (direction === "onramp") return { provider, direction, status: "ready" };
  return {
    provider,
    direction,
    status: "collect_account",
    payout: payoutTree(world, counterpartyId, params.get("fiatCurrency") ?? "USD"),
  };
}

const advanceSchema = z.object({
  provider: z.string(),
  direction: z.enum(["onramp", "offramp"]),
  fiatCurrency: z.string().default("USD"),
  collectedData: z.record(z.string(), z.string()).optional(),
  providerAccountId: z.string().optional(),
  agreementConsent: z.boolean().optional(),
});

function advanceRequirements({ segments, body, world, now }: WriteContext): DemoWriteResult {
  const counterpartyId = segments[1] ?? "";
  if (!contactById(world, counterpartyId)) return error(404, "Contact not found.", "not_found");
  const input = parse(advanceSchema, body);
  if ("failure" in input) return input.failure;
  const { provider, direction, fiatCurrency, collectedData, providerAccountId } = input.data;
  if (!isRampProvider(provider)) return error(400, "That provider isn't part of the demo.");
  if (provider === "bvnk" && !world.consents.includes(consentKey(provider, counterpartyId))) {
    if (input.data.agreementConsent !== true) {
      return record([], () => ok({ data: bvnkAgreements(direction) }));
    }
    return record([{ k: "consent", id: counterpartyId, at: now.getTime(), provider }], () =>
      ok({ data: { provider, direction, status: "ready" } })
    );
  }
  if (provider !== "lightspark" || direction === "onramp") {
    return record([], () => ok({ data: { provider, direction, status: "ready" } }));
  }
  const ready = (id: string) =>
    ok({ data: { provider, direction, status: "ready", providerAccountId: id } });
  if (providerAccountId !== undefined) {
    const saved = savedPayoutAccounts(world, counterpartyId, fiatCurrency);
    if (!saved.some((account) => account.id === providerAccountId)) {
      return error(404, "That bank account is not saved for this contact.", "not_found");
    }
    return record([], () => ready(providerAccountId));
  }
  const country = collectedData?.destinationCountry;
  const corridor = corridorsFor(fiatCurrency).find((candidate) => candidate.country === country);
  if (!country || !corridor) return error(400, "Choose the country the bank account is in.");
  const rail = collectedData?.paymentRails ?? corridor.rails[0]?.value ?? "ACH";
  const accountNumber = collectedData?.accountNumber ?? collectedData?.iban ?? "";
  const id = newDemoId("cppa");
  return record(
    [
      {
        k: "payout-account",
        id,
        at: now.getTime(),
        cp: counterpartyId,
        country,
        rail,
        fiat: fiatCurrency,
        bank: collectedData?.bankName?.trim() || null,
        last4: accountNumber.length >= 4 ? accountNumber.slice(-4) : null,
      },
    ],
    () => ready(id)
  );
}

// ─── Ramps: estimates and quotes ─────────────────────────────────────────────

/** US dollars per unit of each fiat currency, for demo rates. */
const USD_PER_UNIT: Record<string, number> = {
  USD: 1,
  EUR: 1.08,
  GBP: 1.27,
  CAD: 0.73,
  AUD: 0.66,
  MXN: 0.055,
  BRL: 0.18,
  ARS: 0.0011,
  NGN: 0.00065,
  KES: 0.0077,
};
/** Each provider's cut of what is sent, so the provider cards compare the way real ones do. */
const PROVIDER_FEE_RATE: Record<RampProviderId, number> = {
  lightspark: 0.01,
  bvnk: 0.008,
  mural: 0.006,
  moonpay: 0.035,
  coinbase: 0.015,
  moneygram: 0.02,
  stripe: 0.029,
};
const QUOTE_TTL_MS = 15 * MINUTE_MS;

type RampDirection = "onramp" | "offramp";

function usdPerUnit(fiatCurrency: string): number {
  return USD_PER_UNIT[fiatCurrency] ?? 1;
}

/** The providers that run a pair, as the support tables list them. */
function pairProviders(
  direction: RampDirection,
  fiatCurrency: string,
  assetRail: string
): readonly RampProviderId[] {
  const row =
    direction === "onramp"
      ? ONRAMP_SUPPORT.find((entry) => entry.source === fiatCurrency && entry.dest === assetRail)
      : OFFRAMP_SUPPORT.find((entry) => entry.source === assetRail && entry.dest === fiatCurrency);
  return row?.providers ?? [];
}

interface RampAmounts {
  fiat: number;
  crypto: number;
  fee: number;
  /** Units of crypto per unit of fiat. */
  rate: number;
  mint: string;
  symbol: string;
  decimals: number;
}

/** Both sides of a ramp at the demo rate, the provider's fee taken from what is sent. */
function rampAmounts(
  provider: RampProviderId,
  direction: RampDirection,
  fiatCurrency: string,
  assetRail: string,
  amount: number
): RampAmounts {
  const mint = mintForRail(assetRail);
  const token = DEMO_TOKENS[tokenKeyForMint(mint) ?? "USDC"];
  const rate = usdPerUnit(fiatCurrency) / token.usdPrice;
  const feeRate = PROVIDER_FEE_RATE[provider];
  const common = { rate, mint, symbol: token.symbol, decimals: token.decimals };
  if (direction === "onramp") {
    const fee = amount * feeRate;
    return { ...common, fiat: amount, crypto: (amount - fee) * rate, fee };
  }
  const gross = amount / rate;
  const fee = gross * feeRate;
  return { ...common, fiat: gross - fee, crypto: amount, fee };
}

/** A crypto amount as a person reads it: cents for a stablecoin, four places for SOL. */
function cryptoText(amounts: RampAmounts): string {
  return scaled(amounts.crypto, amounts.symbol === "SOL" ? 4 : 2);
}

const estimateSchema = z.object({
  assetRail: z.string(),
  fiatCurrency: z.string(),
  fiatAmount: z.string().optional(),
  cryptoAmount: z.string().optional(),
});

function estimate({ segments, body, now }: WriteContext): DemoWriteResult {
  const direction = segments[2] === "offramp" ? "offramp" : "onramp";
  const input = parse(estimateSchema, body);
  if ("failure" in input) return input.failure;
  const { assetRail, fiatCurrency } = input.data;
  const raw = direction === "onramp" ? input.data.fiatAmount : input.data.cryptoAmount;
  const amount = raw !== undefined && DECIMAL.test(raw) ? Number(raw) : 0;
  const expiresAt = new Date(now.getTime() + QUOTE_TTL_MS).toISOString();
  const estimates: RampProviderEstimateResult[] = pairProviders(
    direction,
    fiatCurrency,
    assetRail
  ).map((provider) => {
    const amounts = rampAmounts(provider, direction, fiatCurrency, assetRail, amount);
    return {
      provider,
      status: "ok",
      estimate: {
        provider,
        direction,
        fiatCurrency: fiatCurrency as PaymentRampEstimate["fiatCurrency"],
        assetRail: assetRail as PaymentRampEstimate["assetRail"],
        fiatAmount: scaled(amounts.fiat, 2),
        cryptoAmount: cryptoText(amounts),
        exchangeRate: scaled(amounts.rate, 6),
        fees: {
          currency: fiatCurrency as PaymentRampEstimate["fiatCurrency"],
          total: scaled(amounts.fee, 2),
        },
        expiresAt,
      },
    };
  });
  return record([], () => ok({ data: { estimates } }));
}

const onrampQuoteSchema = z.object({
  provider: z.string(),
  counterpartyId: z.string().min(1),
  destinationCustodyWalletId: z.string().min(1),
  assetRail: z.string(),
  fiatCurrency: z.string(),
  fiatAmount: amountSchema,
});

const offrampQuoteSchema = z.object({
  provider: z.string(),
  counterpartyId: z.string().min(1),
  sourceCustodyWalletId: z.string().min(1),
  assetRail: z.string(),
  cryptoAmount: amountSchema,
  fiatCurrency: z.string().default("USD"),
  providerAccountId: z.string().optional(),
});

/** The bank account an on-ramp's customer pays into, as the provider shows it. */
function fundingAccount(fiatCurrency: string, reference: string) {
  if (fiatCurrency === "EUR") {
    return {
      accountType: "IBAN",
      accountNumber: "DE89370400440532013000",
      paymentRails: ["SEPA"],
      reference,
      bankName: "Lightspark Sandbox Bank",
    };
  }
  if (fiatCurrency === "GBP") {
    return {
      accountType: "GB_ACCOUNT",
      accountNumber: "31926819",
      routingNumber: "601613",
      paymentRails: ["FPS"],
      reference,
      bankName: "Lightspark Sandbox Bank",
    };
  }
  return {
    accountType: "US_ACCOUNT",
    accountNumber: "000123456789",
    routingNumber: "021000021",
    paymentRails: ["ACH", "WIRE"],
    reference,
    bankName: "Lightspark Sandbox Bank",
  };
}

/** Everything a provider's demo quote is drawn from. */
interface QuoteContext {
  quoteId: string;
  transferId: string;
  reference: string;
  expiresAt: string;
  fiatCurrency: string;
  amounts: RampAmounts;
  crypto: string;
  /** The wallet the crypto lands in (on-ramp) or leaves from (off-ramp). */
  walletAddress: string;
  /** Where an off-ramp's crypto is sent. */
  depositAddress: Address;
}

function bvnkBankAccount(fiatCurrency: string, reference: string) {
  return fiatCurrency === "EUR"
    ? {
        accountNumber: "GB33BUKB20201555555555",
        code: "BUKBGB22",
        accountNumberFormat: "IBAN",
        paymentReference: reference,
        bankName: "BVNK Sandbox Bank",
      }
    : {
        accountNumber: "8310005521",
        routingNumber: "026073150",
        accountNumberFormat: "ACH",
        paymentReference: reference,
        bankName: "BVNK Sandbox Bank",
      };
}

function muralBankDetails(fiatCurrency: string, reference: string): Record<string, string> {
  return {
    bankName: "Mural Sandbox Bank",
    beneficiaryName: "Mural Pay Sandbox",
    accountNumber: fiatCurrency === "USD" ? "7721009934" : "CLABE 646180157000000004",
    ...(fiatCurrency === "USD" ? { routingNumber: "101019644" } : {}),
    reference,
  };
}

/** A provider's on-ramp quote: bank instructions, a hosted checkout, or a widget session. */
function onrampQuoteFor(provider: RampProviderId, q: QuoteContext): PaymentRampQuote {
  const base = { id: q.quoteId, status: "pending" as const };
  const { amounts, fiatCurrency, reference } = q;
  switch (provider) {
    case "lightspark":
      return {
        ...base,
        provider,
        deliveryMode: "manual_instructions",
        paymentInstructions: [
          {
            provider,
            accountOrWalletInfo: fundingAccount(fiatCurrency, reference),
            instructionsNotes: "Include the reference so the payment is matched to this deposit.",
            isPlatformAccount: true,
          },
        ],
        exchangeRate: amounts.rate,
        totalSendingAmount: Math.round(amounts.fiat * 100),
        sendingCurrency: { code: fiatCurrency, decimals: 2 },
        totalReceivingAmount: Number(toBaseUnits(q.crypto, amounts.decimals)),
        receivingCurrency: { code: amounts.symbol, decimals: amounts.decimals },
        feesIncluded: Math.round(amounts.fee * 100),
        feeCurrency: { code: fiatCurrency, decimals: 2 },
        expiresAt: q.expiresAt,
      };
    case "bvnk":
      return {
        ...base,
        provider,
        deliveryMode: "manual_instructions",
        paymentInstructions: [
          {
            provider,
            kind: "fiat_funding",
            onboardingStatus: "ready",
            fiatCurrency,
            beneficiaryAddress: q.walletAddress,
            network: "SOLANA",
            bankAccount: bvnkBankAccount(fiatCurrency, reference),
            paymentReference: reference,
            instructionsNotes: "Include the reference so BVNK matches the payment to this deposit.",
          },
        ],
      };
    case "mural":
      return {
        ...base,
        provider,
        deliveryMode: "manual_instructions",
        paymentInstructions: [
          {
            provider,
            fiatCurrency,
            payinRails: fiatCurrency === "USD" ? ["ACH", "WIRE"] : ["SPEI"],
            bankDetails: muralBankDetails(fiatCurrency, reference),
          },
        ],
      };
    case "moonpay":
      return {
        ...base,
        provider,
        deliveryMode: "hosted",
        hostedUrl: `https://buy-sandbox.moonpay.com/?externalTransactionId=${q.transferId}`,
      };
    case "coinbase":
      return {
        ...base,
        provider,
        deliveryMode: "hosted",
        hostedUrl: `https://pay.coinbase.com/v2/api-onramp/purchase?orderId=${q.quoteId}`,
        paymentCurrency: fiatCurrency,
        paymentSubtotal: scaled(amounts.fiat - amounts.fee, 2),
        paymentTotal: scaled(amounts.fiat, 2),
        purchaseCurrency: amounts.symbol,
        purchaseAmount: q.crypto,
        exchangeRate: scaled(1 / amounts.rate, 2),
        fees: [
          {
            feeAmount: scaled(amounts.fee, 2),
            feeCurrency: fiatCurrency,
            feeType: "FEE_TYPE_EXCHANGE",
          },
        ],
      };
    case "moneygram":
      return {
        ...base,
        provider,
        deliveryMode: "session_widget",
        sessionToken: `demo.${q.quoteId}`,
        sessionId: q.quoteId,
        widgetUrl: "https://playground.xramps.moneygram.com/",
        expiresAt: q.expiresAt,
      };
    case "stripe":
      return {
        ...base,
        provider,
        deliveryMode: "session_widget",
        clientSecret: `cos_${q.quoteId}_secret_demo`,
        sessionId: q.quoteId,
        publishableKey: "pk_test_demo",
      };
  }
}

/** A provider's off-ramp quote: where to send the crypto, or its hosted page or widget. */
function offrampQuoteFor(provider: RampProviderId, q: QuoteContext): PaymentRampQuote {
  const base = { id: q.quoteId, status: "pending" as const };
  const { amounts, fiatCurrency, reference } = q;
  const symbol = amounts.symbol as "USDC";
  switch (provider) {
    case "bvnk":
      return {
        ...base,
        provider,
        deliveryMode: "manual_instructions",
        paymentInstructions: [
          {
            provider,
            kind: "crypto_deposit",
            destinationAddress: q.depositAddress,
            cryptoCurrency: symbol,
            network: "SOLANA",
            reference,
            fiatCurrency: fiatCurrency as RampFiatCurrency,
            instructionsNotes: "Send exactly this amount; BVNK pays out once it arrives.",
          },
        ],
      };
    case "moonpay":
      return {
        ...base,
        provider,
        deliveryMode: "hosted",
        hostedUrl: `https://sell-sandbox.moonpay.com/?externalTransactionId=${q.transferId}`,
      };
    case "moneygram":
      return {
        ...base,
        provider,
        deliveryMode: "session_widget",
        sessionToken: `demo.${q.quoteId}`,
        sessionId: q.quoteId,
        widgetUrl: "https://playground.xramps.moneygram.com/",
        expiresAt: q.expiresAt,
      };
    default:
      return {
        ...base,
        provider: "lightspark",
        deliveryMode: "manual_instructions",
        paymentInstructions: [
          {
            provider: "lightspark",
            kind: "crypto_deposit",
            destinationAddress: q.depositAddress,
            cryptoCurrency: symbol,
            network: "SOLANA",
            reference,
            accountOrWalletInfo: {
              accountType: "SOLANA_WALLET",
              address: q.depositAddress,
              assetType: symbol,
            },
            instructionsNotes: "Send exactly this amount; the payout starts once it arrives.",
          },
        ],
        exchangeRate: 1 / amounts.rate,
        totalSendingAmount: Number(toBaseUnits(q.crypto, amounts.decimals)),
        sendingCurrency: { code: symbol, decimals: amounts.decimals },
        totalReceivingAmount: Math.round(amounts.fiat * 100),
        receivingCurrency: { code: fiatCurrency, decimals: 2 },
        feesIncluded: Math.round(amounts.fee * 100),
        feeCurrency: { code: fiatCurrency, decimals: 2 },
        expiresAt: q.expiresAt,
      };
  }
}

function pairRefusal(provider: RampProviderId, from: string, to: string): DemoWriteResult {
  return error(400, `${getRampProviderLabel(provider)} doesn't run ${from} to ${to}.`);
}

function quote({ segments, body, world, now }: WriteContext): DemoWriteResult {
  const direction = segments[2] === "offramp" ? "offramp" : "onramp";
  const head = z.object({ provider: z.string() }).safeParse(body);
  const provider = head.success ? head.data.provider : "";
  if (!isRampProvider(provider)) return error(400, "That provider isn't part of the demo.");
  const at = now.getTime();
  const id = newDemoId("xfr");
  const quoteId = newDemoId("quote");
  const context = {
    quoteId,
    transferId: id,
    reference: rampReference(provider, quoteId),
    expiresAt: new Date(at + QUOTE_TTL_MS).toISOString(),
    depositAddress: rampDepositAddress(id) as Address,
  };

  if (direction === "onramp") {
    const input = parse(onrampQuoteSchema, body);
    if ("failure" in input) return input.failure;
    const { counterpartyId, destinationCustodyWalletId, assetRail, fiatCurrency } = input.data;
    if (!contactById(world, counterpartyId)) return error(404, "Contact not found.", "not_found");
    const wallet = findWallet(world, destinationCustodyWalletId);
    if (!wallet) return error(404, "That wallet is not in this project.", "not_found");
    if (!pairProviders(direction, fiatCurrency, assetRail).includes(provider)) {
      return pairRefusal(
        provider,
        fiatCurrency,
        getCryptoRailAssetLabel(assetRail as CryptoRailId)
      );
    }
    const amounts = rampAmounts(
      provider,
      direction,
      fiatCurrency,
      assetRail,
      Number(input.data.fiatAmount)
    );
    const crypto = cryptoText(amounts);
    const onrampQuote = onrampQuoteFor(provider, {
      ...context,
      fiatCurrency,
      amounts,
      crypto,
      walletAddress: wallet.publicKey,
    });
    return record(
      [
        {
          k: "ramp",
          id,
          at,
          provider,
          dir: direction,
          cp: counterpartyId,
          wallet: destinationCustodyWalletId,
          rail: assetRail,
          fiat: fiatCurrency,
          fiatAmount: scaled(amounts.fiat, 2),
          crypto,
          quote: quoteId,
        },
      ],
      () => ok({ data: { quote: onrampQuote, transferId: id } }, 201)
    );
  }

  const input = parse(offrampQuoteSchema, body);
  if ("failure" in input) return input.failure;
  const { counterpartyId, sourceCustodyWalletId, assetRail, fiatCurrency, cryptoAmount } =
    input.data;
  if (!contactById(world, counterpartyId)) return error(404, "Contact not found.", "not_found");
  const wallet = findWallet(world, sourceCustodyWalletId);
  if (!wallet) return error(404, "That wallet is not in this project.", "not_found");
  if (!pairProviders(direction, fiatCurrency, assetRail).includes(provider)) {
    return pairRefusal(provider, getCryptoRailAssetLabel(assetRail as CryptoRailId), fiatCurrency);
  }
  const amounts = rampAmounts(provider, direction, fiatCurrency, assetRail, Number(cryptoAmount));
  const notEnough = shortfall(world, sourceCustodyWalletId, amounts.mint, cryptoAmount);
  if (notEnough) return error(400, notEnough, "insufficient_funds");
  const offrampQuote = offrampQuoteFor(provider, {
    ...context,
    fiatCurrency,
    amounts,
    crypto: cryptoAmount,
    walletAddress: wallet.publicKey,
  });
  return record(
    [
      {
        k: "ramp",
        id,
        at,
        provider,
        dir: direction,
        cp: counterpartyId,
        wallet: sourceCustodyWalletId,
        rail: assetRail,
        fiat: fiatCurrency,
        fiatAmount: scaled(amounts.fiat, 2),
        crypto: cryptoAmount,
        quote: quoteId,
      },
    ],
    () => ok({ data: { quote: offrampQuote, transferId: id } }, 201)
  );
}

const simulateSchema = z.object({
  provider: z.string(),
  payload: z
    .object({
      quoteId: z.string().optional(),
      transferId: z.string().optional(),
      counterpartyId: z.string().optional(),
    })
    .passthrough(),
});

/** The sandbox's "the customer paid": the on-ramp it names settles a few seconds later. */
function simulatePayIn({ body, world, ops, now }: WriteContext): DemoWriteResult {
  const input = parse(simulateSchema, body);
  if ("failure" in input) return input.failure;
  const { quoteId, transferId, counterpartyId } = input.data.payload;
  const rampOps = ops.filter((op) => op.k === "ramp" && op.dir === "onramp");
  const match =
    rampOps.find((op) => op.k === "ramp" && (op.quote === quoteId || op.id === transferId)) ??
    [...rampOps]
      .reverse()
      .find(
        (op) =>
          op.k === "ramp" &&
          op.cp === counterpartyId &&
          transferById(world, op.id)?.status === "awaiting_payment"
      );
  const target = match ? transferById(world, match.id) : undefined;
  if (!match || !target) return error(404, "No deposit is waiting for that payment.", "not_found");
  if (target.status !== "awaiting_payment") {
    return error(409, "That deposit has already been paid.", "conflict");
  }
  return record([{ k: "ramp-paid", id: match.id, at: now.getTime() }], () => ok({ data: {} }));
}

const cancelRampSchema = z.object({ transferId: z.string().min(1) });

function cancelRamp({ body, world, now }: WriteContext): DemoWriteResult {
  const input = parse(cancelRampSchema, body);
  if ("failure" in input) return input.failure;
  const transfer = transferById(world, input.data.transferId);
  if (!transfer) return error(404, "Transfer not found.", "not_found");
  if (transfer.status !== "awaiting_payment") {
    return error(409, "This transfer can no longer be canceled.", "conflict");
  }
  const id = transfer.id;
  return record([{ k: "ramp-cancel", id, at: now.getTime() }], (after) =>
    ok({ data: { transfer: transferById(after, id) } })
  );
}

// ─── Transfers and batches ───────────────────────────────────────────────────

const transferSchema = z.object({
  transferId: z.string().trim().min(1).max(80).optional(),
  sourceCustodyWalletId: z.string().min(1),
  destination: addressSchema,
  token: z.string().min(1),
  amount: amountSchema,
  memo: z.string().max(200).nullish(),
});

function createTransfer({ body, world, now }: WriteContext): DemoWriteResult {
  const input = parse(transferSchema, body);
  if ("failure" in input) return input.failure;
  const { transferId, sourceCustodyWalletId, destination, token, amount, memo } = input.data;
  const existing = transferId === undefined ? undefined : transferById(world, transferId);
  const at = now.getTime();

  // Funding an off-ramp: the crypto goes to the provider's deposit address.
  if (existing?.type === "offramp") {
    if (existing.status !== "awaiting_payment") {
      return error(409, "This payout has already been funded.", "conflict");
    }
    const notEnough = shortfall(world, sourceCustodyWalletId, token, amount);
    if (notEnough) return error(400, notEnough, "insufficient_funds");
    const id = existing.id;
    return record([{ k: "ramp-paid", id, at }], (after) =>
      ok({ data: { transfer: transferById(after, id) } }, 201)
    );
  }
  // The same payment sent again answers with the first one.
  if (existing) return record([], () => ok({ data: { transfer: existing } }));

  const wallet = findWallet(world, sourceCustodyWalletId);
  if (!wallet) return error(404, "That wallet is not in this project.", "not_found");
  if (destination === wallet.publicKey) {
    return error(400, "Choose an address other than the wallet sending the payment.");
  }
  const notEnough = shortfall(world, wallet.id, token, amount);
  if (notEnough) return error(400, notEnough, "insufficient_funds");
  const id = transferId?.startsWith("demo_") ? transferId : newDemoId("xfr");
  return record(
    [{ k: "send", id, at, wallet: wallet.id, to: destination, token, amount, memo: memo || null }],
    (after) => ok({ data: { transfer: transferById(after, id) } }, 201)
  );
}

const batchSchema = z.object({
  externalId: z.string().trim().max(80).nullish(),
  sourceCustodyWalletId: z.string().min(1),
  token: z.string().min(1),
  recipients: z
    .array(
      z.object({
        counterpartyId: z.string().min(1),
        counterpartyAccountId: z.string().min(1),
        amount: amountSchema,
      })
    )
    .min(1, "Add at least one recipient.")
    .max(200),
});

function batchTotal(amounts: readonly string[], mint: string): string {
  const { decimals } = DEMO_TOKENS[tokenKeyForMint(mint) ?? "USDC"];
  return fromBaseUnits(
    amounts.reduce((sum, amount) => sum + toBaseUnits(amount, decimals), 0n),
    decimals,
    2
  );
}

function checkBatch(world: DemoWorld, input: z.infer<typeof batchSchema>): DemoWriteResult | null {
  if (!findWallet(world, input.sourceCustodyWalletId)) {
    return error(404, "That wallet is not in this project.", "not_found");
  }
  for (const recipient of input.recipients) {
    const account = accountById(world, recipient.counterpartyAccountId);
    if (!account || account.counterpartyId !== recipient.counterpartyId) {
      return error(400, "A recipient's address is not saved for that contact.");
    }
  }
  const total = batchTotal(
    input.recipients.map((recipient) => recipient.amount),
    input.token
  );
  const notEnough = shortfall(world, input.sourceCustodyWalletId, input.token, total);
  return notEnough ? error(400, notEnough, "insufficient_funds") : null;
}

function estimateBatch({ body, world }: WriteContext): DemoWriteResult {
  const input = parse(batchSchema, body);
  if ("failure" in input) return input.failure;
  const problem = checkBatch(world, input.data);
  if (problem) return problem;
  const recipientCount = input.data.recipients.length;
  const transactionCount = Math.ceil(recipientCount / DEMO_BATCH_RECIPIENTS_PER_TRANSACTION);
  return record([], () =>
    ok({
      data: {
        estimate: {
          recipientCount,
          transactionCount,
          estimatedFees: {
            networkFeeLamports: String(5_000 * transactionCount),
            priorityFeeLamports: String(10_000 * transactionCount),
            tokenAccountRentLamports: "0",
            sponsored: false,
          },
        },
      },
    })
  );
}

function createBatch({ body, world, now }: WriteContext): DemoWriteResult {
  const input = parse(batchSchema, body);
  if ("failure" in input) return input.failure;
  const problem = checkBatch(world, input.data);
  if (problem) return problem;
  const id = newDemoId("batch");
  return record(
    [
      {
        k: "batch",
        id,
        at: now.getTime(),
        wallet: input.data.sourceCustodyWalletId,
        token: input.data.token,
        ext: input.data.externalId || null,
        to: input.data.recipients.map((recipient) => [
          recipient.counterpartyId,
          recipient.counterpartyAccountId,
          recipient.amount,
        ]),
      },
    ],
    (after) => {
      const entry = after.batches.find((candidate) => candidate.batch.id === id);
      const transferIds = new Set(entry?.recipients.map((recipient) => recipient.transferId));
      return ok(
        {
          data: {
            batch: entry?.batch,
            recipients: entry?.recipients ?? [],
            transfers: after.transfers
              .map((row) => row.transfer)
              .filter((transfer) => transferIds.has(transfer.id)),
          },
        },
        201
      );
    }
  );
}

// ─── Requests ────────────────────────────────────────────────────────────────

const requestSchema = z.object({
  walletId: z.string().min(1),
  token: z.string().min(1),
  amount: amountSchema,
  counterpartyId: z.string().nullish(),
  expiresAt: z.string().nullish(),
});

function createRequest({ body, world, now }: WriteContext): DemoWriteResult {
  const input = parse(requestSchema, body);
  if ("failure" in input) return input.failure;
  const wallet = findWallet(world, input.data.walletId);
  if (!wallet) return error(404, "That wallet is not in this project.", "not_found");
  const counterpartyId = input.data.counterpartyId ?? null;
  if (counterpartyId !== null && !contactById(world, counterpartyId)) {
    return error(404, "Contact not found.", "not_found");
  }
  const expiresAt = input.data.expiresAt ?? null;
  if (expiresAt !== null && !(Date.parse(expiresAt) > now.getTime())) {
    return error(400, "Choose an expiry in the future.");
  }
  const id = newDemoId("preq");
  return record(
    [
      {
        k: "request",
        id,
        at: now.getTime(),
        wallet: wallet.id,
        token: input.data.token,
        amount: input.data.amount,
        cp: counterpartyId,
        expires: expiresAt,
      },
    ],
    (after) => ok({ data: after.requests.find((request) => request.id === id) }, 201)
  );
}

// ─── Schedules ───────────────────────────────────────────────────────────────

const periodSchema = z.number().int().min(1, "Repeat at least every hour.").max(8760);

const scheduleSchema = z.object({
  sourceCustodyWalletId: z.string().min(1),
  counterpartyId: z.string().min(1),
  counterpartyAccountId: z.string().min(1),
  token: z.string().min(1),
  amount: amountSchema,
  periodHours: periodSchema,
  firstCollectionAt: z.string().nullish(),
});

function scheduleAnswer(id: string, status = 200) {
  return (after: DemoWorld) =>
    ok(
      { data: { recurringPayment: after.schedules.find((schedule) => schedule.id === id) } },
      status
    );
}

function createSchedule({ body, world, now }: WriteContext): DemoWriteResult {
  const input = parse(scheduleSchema, body);
  if ("failure" in input) return input.failure;
  const { sourceCustodyWalletId, counterpartyId, counterpartyAccountId } = input.data;
  if (!findWallet(world, sourceCustodyWalletId)) {
    return error(404, "That wallet is not in this project.", "not_found");
  }
  const account = accountById(world, counterpartyAccountId);
  if (!account || account.counterpartyId !== counterpartyId) {
    return error(400, "Choose an address saved for this contact.");
  }
  const first = input.data.firstCollectionAt ?? null;
  if (first !== null && !(Date.parse(first) > now.getTime())) {
    return error(400, "Choose a start date after today.");
  }
  const id = newDemoId("rp");
  return record(
    [
      {
        k: "schedule",
        id,
        at: now.getTime(),
        wallet: sourceCustodyWalletId,
        cp: counterpartyId,
        account: counterpartyAccountId,
        token: input.data.token,
        amount: input.data.amount,
        period: input.data.periodHours,
        first,
      },
    ],
    scheduleAnswer(id, 201)
  );
}

const updateScheduleSchema = z.object({
  amount: amountSchema.optional(),
  token: z.string().min(1).optional(),
  periodHours: periodSchema.optional(),
  sourceCustodyWalletId: z.string().min(1).optional(),
  counterpartyAccountId: z.string().min(1).optional(),
});

function updateSchedule({ segments, body, world, now }: WriteContext): DemoWriteResult {
  const id = segments[2] ?? "";
  const schedule = world.schedules.find((candidate) => candidate.id === id);
  if (!schedule) return error(404, "Schedule not found.", "not_found");
  if (schedule.status !== "pending_activation" && schedule.status !== "active") {
    return error(409, "This schedule cannot be changed from its current status.", "conflict");
  }
  const input = parse(updateScheduleSchema, body);
  if ("failure" in input) return input.failure;
  const { sourceCustodyWalletId, counterpartyAccountId } = input.data;
  if (sourceCustodyWalletId !== undefined && !findWallet(world, sourceCustodyWalletId)) {
    return error(404, "That wallet is not in this project.", "not_found");
  }
  if (counterpartyAccountId !== undefined) {
    const account = accountById(world, counterpartyAccountId);
    if (!account || account.counterpartyId !== schedule.counterpartyId) {
      return error(400, "Choose an address saved for this contact.");
    }
  }
  return record(
    [
      {
        k: "schedule-update",
        id,
        at: now.getTime(),
        ...(input.data.amount === undefined ? {} : { amount: input.data.amount }),
        ...(input.data.token === undefined ? {} : { token: input.data.token }),
        ...(input.data.periodHours === undefined ? {} : { period: input.data.periodHours }),
        ...(sourceCustodyWalletId === undefined ? {} : { wallet: sourceCustodyWalletId }),
        ...(counterpartyAccountId === undefined ? {} : { account: counterpartyAccountId }),
      },
    ],
    scheduleAnswer(id)
  );
}

const SCHEDULE_ACTIONS = ["activate", "collect", "cancel", "resume"] as const;
type ScheduleAction = (typeof SCHEDULE_ACTIONS)[number];

function scheduleActionRefusal(
  action: ScheduleAction,
  schedule: DemoWorld["schedules"][number],
  world: DemoWorld,
  now: Date
): DemoWriteResult | null {
  switch (action) {
    case "activate":
      return schedule.status === "pending_activation"
        ? null
        : error(409, "Only a schedule waiting for activation can be activated.", "conflict");
    case "collect": {
      if (schedule.status !== "active") {
        return error(409, "Only an active schedule can collect.", "conflict");
      }
      const due = schedule.nextCollectionDueAt;
      if (due === null || Date.parse(due) > now.getTime()) {
        return error(409, "The next run isn't due yet.", "conflict");
      }
      const notEnough = shortfall(
        world,
        schedule.sourceCustodyWalletId ?? "",
        schedule.token,
        schedule.amount
      );
      return notEnough ? error(400, notEnough, "insufficient_funds") : null;
    }
    case "cancel":
      return schedule.status === "pending_activation" || schedule.status === "active"
        ? null
        : error(409, "This schedule is not running.", "conflict");
    case "resume":
      return schedule.status === "canceled" && schedule.subscriptionId
        ? null
        : error(409, "Only a canceled schedule that has run can be resumed.", "conflict");
  }
}

function runScheduleAction({ segments, world, now }: WriteContext): DemoWriteResult {
  const id = segments[2] ?? "";
  const action = SCHEDULE_ACTIONS.find((candidate) => candidate === segments[3]);
  const schedule = world.schedules.find((candidate) => candidate.id === id);
  if (!schedule || !action) return error(404, "Schedule not found.", "not_found");
  const refusal = scheduleActionRefusal(action, schedule, world, now);
  if (refusal) return refusal;
  return record([{ k: "schedule-action", id, at: now.getTime(), action }], scheduleAnswer(id));
}

// ─── Routing ─────────────────────────────────────────────────────────────────

type Handler = (context: WriteContext) => DemoWriteResult;

/** The handler for a write, by method and path shape (`*` stands for any one segment). */
const WRITE_ROUTES: ReadonlyArray<[method: string, shape: string, handler: Handler]> = [
  ["POST", "counterparties", createContact],
  ["DELETE", "counterparties/*", archiveContact],
  ["POST", "counterparties/*/accounts", createAccount],
  ["POST", "counterparties/*/requirements", advanceRequirements],
  ["POST", "compliance/address-screenings", screenAddress],
  ["POST", "payments/transfers", createTransfer],
  ["POST", "payments/transfer-batches/estimate", estimateBatch],
  ["POST", "payments/transfer-batches", createBatch],
  ["POST", "payments/ramps/*/estimate", estimate],
  ["POST", "payments/ramps/*/quote", quote],
  ["POST", "payments/ramps/sandbox/simulate", simulatePayIn],
  ["POST", "payments/ramps/transfers/cancel", cancelRamp],
  ["POST", "payments/ramps/*/events", () => record([], () => ({ status: 204 }))],
  ["POST", "payments/requests", createRequest],
  ["POST", "payments/recurring-payments", createSchedule],
  ["PATCH", "payments/recurring-payments/*", updateSchedule],
  ["POST", "payments/recurring-payments/*/*", runScheduleAction],
];

function matchesShape(segments: readonly string[], shape: string): boolean {
  const parts = shape.split("/");
  return (
    parts.length === segments.length &&
    parts.every((part, index) => part === "*" || part === segments[index])
  );
}

/**
 * The demo's handling of a write, or undefined when demo mode has no stand-in for it. Literal
 * shapes are tried before wildcard ones, so `ramps/sandbox/simulate` never reads as a quote.
 */
export function demoWrite(method: string, context: WriteContext): DemoWriteResult | undefined {
  const candidates = WRITE_ROUTES.filter(
    ([routeMethod, shape]) => routeMethod === method && matchesShape(context.segments, shape)
  ).sort(([, left], [, right]) => left.split("*").length - right.split("*").length);
  const handler = candidates[0]?.[2];
  return handler ? handler(context) : undefined;
}

/** Reads a flow makes that the fixtures don't hold: ramp requirements and wallet approvals. */
export function demoFlowRead(
  segments: readonly string[],
  params: URLSearchParams,
  world: DemoWorld
): DemoAnswer | undefined {
  if (matchesShape(segments, "counterparties/*/requirements")) {
    const counterpartyId = segments[1] ?? "";
    if (!contactById(world, counterpartyId)) {
      return { status: 404, body: { error: { code: "not_found", message: "Contact not found." } } };
    }
    return ok({ data: requirementsFor(world, counterpartyId, params) });
  }
  if (matchesShape(segments, "wallets/approval-requests")) {
    return ok({ data: { approvalRequests: [] } });
  }
  return undefined;
}
