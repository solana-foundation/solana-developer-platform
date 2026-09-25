import {
  type Counterparty,
  type CounterpartyAccount,
  type CounterpartyAccountSummary,
  type CounterpartyEntityType,
  type CounterpartyProviderAccount,
  type CustodyProvider,
  type CustodyWalletAggregate,
  type CustodyWalletTokenBalance,
  type PaymentRampQuoteDeliveryMode,
  type PaymentRecurringPayment,
  type PaymentRecurringPaymentStatus,
  type PaymentRequest,
  type PaymentRequestStatus,
  type PaymentSubscriptionCollectionAttempt,
  type PaymentsDashboardWallet,
  type PaymentTransactionKind,
  type PaymentTransferBatch,
  type PaymentTransferBatchStatus,
  type PaymentTransferRecipient,
  type PaymentTransferStatus,
  type PaymentTransferSummary,
  type PaymentTransferType,
  type RampProviderId,
  SOL_MINT,
  UNIFIED_TRANSACTION_MODULE_CONTRACTS,
  type UnifiedTransaction,
  WELL_KNOWN_TOKENS,
} from "@sdp/types";

/*
 * Demo data for the Payments screens. Every GET the Payments pages send upstream is answered
 * from one small, cross-referenced world built fresh for each call: three wallets, seven
 * contacts, their transfers, batches, requests and schedules. Timestamps are offsets from
 * `now`, so the activity always reads as recent; ids carry a `demo_` prefix; addresses and
 * signatures are derived from fixed seeds, so they are stable across calls and renders.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const ORGANIZATION_ID = "demo_org";
const PROJECT_ID = "demo_prj";
const CREATED_BY = "demo_user_ops";
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const DEFAULT_TRANSACTIONS_LIMIT = 50;
const TRANSACTIONS_CURSOR_PREFIX = "demo_cursor_";

// ─── Tokens ──────────────────────────────────────────────────────────────────

const DEMO_TOKENS = {
  USDC: {
    symbol: WELL_KNOWN_TOKENS.USDC.symbol,
    mint: WELL_KNOWN_TOKENS.USDC.mints.devnet.address,
    decimals: WELL_KNOWN_TOKENS.USDC.mints.devnet.decimals,
    usdPrice: 1,
  },
  SOL: {
    symbol: WELL_KNOWN_TOKENS.SOL.symbol,
    mint: SOL_MINT,
    decimals: WELL_KNOWN_TOKENS.SOL.mints.devnet.decimals,
    usdPrice: 148.2,
  },
  EURC: {
    symbol: WELL_KNOWN_TOKENS.EURC.symbol,
    mint: WELL_KNOWN_TOKENS.EURC.mints.devnet.address,
    decimals: WELL_KNOWN_TOKENS.EURC.mints.devnet.decimals,
    usdPrice: 1.08,
  },
} as const;

type DemoTokenKey = keyof typeof DEMO_TOKENS;

function toBaseUnits(uiAmount: string, decimals: number): bigint {
  const [whole = "0", fraction = ""] = uiAmount.split(".");
  const scaledFraction = fraction.padEnd(decimals, "0").slice(0, decimals);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(scaledFraction || "0");
}

/** A base-unit amount as a decimal string, keeping at least `minFractionDigits`. */
function fromBaseUnits(amount: bigint, decimals: number, minFractionDigits = 0): string {
  const scale = 10n ** BigInt(decimals);
  const whole = amount / scale;
  const trimmed = (amount % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  const fraction = trimmed.padEnd(minFractionDigits, "0");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function sumAmounts(amounts: readonly string[], token: DemoTokenKey): string {
  const { decimals } = DEMO_TOKENS[token];
  const total = amounts.reduce((sum, amount) => sum + toBaseUnits(amount, decimals), 0n);
  return fromBaseUnits(total, decimals, 2);
}

function usdValueOf(uiAmount: string, usdPrice: number): number {
  return Math.round(Number(uiAmount) * usdPrice * 100) / 100;
}

function tokenBalance(key: DemoTokenKey, uiAmount: string): CustodyWalletTokenBalance {
  const token = DEMO_TOKENS[key];
  const amount = toBaseUnits(uiAmount, token.decimals);
  const normalizedUiAmount = fromBaseUnits(amount, token.decimals);
  return {
    token: token.symbol,
    mint: token.mint,
    amount: amount.toString(),
    uiAmount: normalizedUiAmount,
    decimals: token.decimals,
    usdPrice: token.usdPrice,
    usdValue: usdValueOf(normalizedUiAmount, token.usdPrice),
  };
}

function symbolForMint(mint: string | null | undefined): string | undefined {
  return Object.values(DEMO_TOKENS).find((token) => token.mint === mint)?.symbol;
}

function matchesToken(mint: string | null | undefined, filter: string): boolean {
  return mint === filter || symbolForMint(mint)?.toUpperCase() === filter.toUpperCase();
}

// ─── Stable base58 addresses and signatures ──────────────────────────────────

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const encodedSeeds = new Map<string, string>();

/** Deterministic bytes for a seed: an FNV-1a hash of the seed drives a mulberry32 stream. */
function seededBytes(seed: string, length: number): Uint8Array {
  let state = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    state = Math.imul(state ^ seed.charCodeAt(index), 0x01000193) >>> 0;
  }
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    bytes[index] = (mixed ^ (mixed >>> 14)) & 0xff;
  }
  // A leading zero byte would shorten the encoding; real keys rarely start with one.
  if (bytes[0] === 0) bytes[0] = 1;
  return bytes;
}

function base58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) {
    value = value * 256n + BigInt(byte);
  }
  let encoded = "";
  while (value > 0n) {
    encoded = `${BASE58_ALPHABET[Number(value % 58n)]}${encoded}`;
    value /= 58n;
  }
  return encoded;
}

function seededBase58(kind: "address" | "signature", seed: string): string {
  const key = `${kind}:${seed}`;
  const cached = encodedSeeds.get(key);
  if (cached !== undefined) return cached;
  const encoded = base58(seededBytes(key, kind === "address" ? 32 : 64));
  encodedSeeds.set(key, encoded);
  return encoded;
}

const demoAddress = (seed: string) => seededBase58("address", seed);
const demoSignature = (seed: string) => seededBase58("signature", seed);

// ─── Specs ───────────────────────────────────────────────────────────────────

type WalletOwner = { custodyConfigId: string } | { custodyConnectionId: string };

interface WalletSpec {
  walletName: string;
  provider: CustodyProvider;
  walletId: string;
  owner: WalletOwner;
  holdings: ReadonlyArray<readonly [DemoTokenKey, string]>;
}

const WALLET_SPECS = {
  treasury: {
    walletName: "Treasury",
    provider: "privy",
    walletId: "demo_privy_treasury",
    owner: { custodyConnectionId: "demo_conn_privy" },
    holdings: [
      ["USDC", "128450.25"],
      ["SOL", "214.5"],
    ],
  },
  payroll: {
    walletName: "Payroll",
    provider: "fireblocks",
    walletId: "demo_fireblocks_vault_12",
    owner: { custodyConfigId: "demo_cfg_fireblocks" },
    holdings: [
      ["USDC", "42300"],
      ["SOL", "1.25"],
    ],
  },
  settlement: {
    walletName: "Settlement",
    provider: "privy",
    walletId: "demo_privy_settlement",
    owner: { custodyConnectionId: "demo_conn_privy" },
    holdings: [
      ["USDC", "8760.4"],
      ["SOL", "36.8"],
      ["EURC", "2500"],
    ],
  },
} as const satisfies Record<string, WalletSpec>;

type WalletKey = keyof typeof WALLET_SPECS;

interface ContactSpec {
  displayName: string;
  entityType: CounterpartyEntityType;
  externalId: string | null;
  accountLabel: string;
  createdDaysAgo: number;
}

const CONTACT_SPECS = {
  acme: {
    displayName: "Acme Logistics",
    entityType: "business",
    externalId: "ACME-001",
    accountLabel: "Operations wallet",
    createdDaysAgo: 96,
  },
  northwind: {
    displayName: "Northwind Traders",
    entityType: "business",
    externalId: "NW-2291",
    accountLabel: "Accounts payable",
    createdDaysAgo: 88,
  },
  lumen: {
    displayName: "Lumen Studio",
    entityType: "business",
    externalId: null,
    accountLabel: "Studio treasury",
    createdDaysAgo: 74,
  },
  orbit: {
    displayName: "Orbit Payroll Ltd",
    entityType: "business",
    externalId: "ORB-PAY-07",
    accountLabel: "Payroll funding",
    createdDaysAgo: 61,
  },
  jane: {
    displayName: "Jane Smith",
    entityType: "individual",
    externalId: null,
    accountLabel: "Personal wallet",
    createdDaysAgo: 120,
  },
  kai: {
    displayName: "Kai Nakamura",
    entityType: "individual",
    externalId: "EMP-0142",
    accountLabel: "Phantom",
    createdDaysAgo: 45,
  },
  priya: {
    displayName: "Priya Raman",
    entityType: "individual",
    externalId: null,
    accountLabel: "Main wallet",
    createdDaysAgo: 19,
  },
} as const satisfies Record<string, ContactSpec>;

type ContactKey = keyof typeof CONTACT_SPECS;

interface RampSpec {
  provider: RampProviderId;
  fiatCurrency: string;
  fiatAmount: string;
  providerReference: string;
  deliveryMode: PaymentRampQuoteDeliveryMode;
}

interface TransferSpec {
  id: string;
  /** How long before `now` the transfer was created. */
  ago: number;
  wallet: WalletKey;
  direction: "inbound" | "outbound";
  kind: PaymentTransactionKind;
  status: PaymentTransferStatus;
  token: DemoTokenKey;
  amount: string;
  type?: PaymentTransferType;
  contact?: ContactKey;
  memo?: string;
  error?: string;
  /** False when no transaction reached the chain. */
  signed?: boolean;
  /** Seed for the other party's address when it is not the contact's saved wallet. */
  external?: string;
  /** A batch chunk pays several recipients, so it names no single destination. */
  multiRecipient?: boolean;
  ramp?: RampSpec;
  rampsMemo?: Record<string, string>;
  /** Chain history SDP did not initiate; listed only with `includeObserved=true`. */
  observed?: boolean;
}

const TRANSFER_SPECS: readonly TransferSpec[] = [
  {
    id: "demo_xfr_acme_inv_20931",
    ago: 12 * MINUTE_MS,
    wallet: "treasury",
    contact: "acme",
    direction: "outbound",
    kind: "pay",
    status: "processing",
    token: "USDC",
    amount: "4820.00",
    memo: "INV-20931",
  },
  {
    id: "demo_xfr_northwind_po_7714",
    ago: 47 * MINUTE_MS,
    wallet: "treasury",
    contact: "northwind",
    direction: "inbound",
    kind: "deposit",
    status: "finalized",
    token: "USDC",
    amount: "12500.00",
    memo: "PO-7714",
  },
  {
    id: "demo_xfr_onramp_coinbase",
    ago: 2 * HOUR_MS + 5 * MINUTE_MS,
    wallet: "treasury",
    contact: "acme",
    direction: "inbound",
    type: "onramp",
    kind: "onramp",
    status: "completed",
    token: "USDC",
    amount: "4982.50",
    external: "coinbase:onramp-hot-wallet",
    ramp: {
      provider: "coinbase",
      fiatCurrency: "USD",
      fiatAmount: "5000.00",
      providerReference: "demo_cb_order_7q2k9",
      deliveryMode: "hosted",
    },
  },
  {
    id: "demo_xfr_priya_design_review",
    ago: 5 * HOUR_MS + 20 * MINUTE_MS,
    wallet: "settlement",
    contact: "priya",
    direction: "outbound",
    kind: "pay",
    status: "failed",
    token: "USDC",
    amount: "350.00",
    memo: "Design review sprint 4",
    error: "Blockhash expired before the transaction landed. No funds moved.",
    signed: false,
  },
  {
    id: "demo_xfr_lumen_request",
    ago: 26 * HOUR_MS,
    wallet: "treasury",
    contact: "lumen",
    direction: "inbound",
    kind: "request_deposit",
    status: "finalized",
    token: "USDC",
    amount: "2400.00",
  },
  {
    id: "demo_xfr_offramp_orbit",
    ago: 2 * DAY_MS + 3 * HOUR_MS,
    wallet: "treasury",
    contact: "orbit",
    direction: "outbound",
    type: "offramp",
    kind: "offramp",
    status: "settling",
    token: "USDC",
    amount: "10000.00",
    external: "bvnk:deposit-address",
    ramp: {
      provider: "bvnk",
      fiatCurrency: "USD",
      fiatAmount: "9975.00",
      providerReference: "demo_bvnk_payout_4471",
      deliveryMode: "manual_instructions",
    },
    rampsMemo: { invoice: "ORB-INV-5521" },
  },
  {
    id: "demo_xfr_northwind_restock",
    ago: 2 * DAY_MS + 7 * HOUR_MS,
    wallet: "treasury",
    contact: "northwind",
    direction: "outbound",
    kind: "pay",
    status: "finalized",
    token: "USDC",
    amount: "7640.00",
    memo: "Q3 inventory restock",
  },
  {
    id: "demo_xfr_acme_freight_rebate",
    ago: 3 * DAY_MS + 2 * HOUR_MS,
    wallet: "settlement",
    contact: "acme",
    direction: "inbound",
    kind: "deposit",
    status: "finalized",
    token: "USDC",
    amount: "3150.00",
    memo: "Freight rebate",
  },
  {
    id: "demo_xfr_lumen_render_credits",
    ago: 4 * DAY_MS + HOUR_MS,
    wallet: "treasury",
    contact: "lumen",
    direction: "outbound",
    kind: "pay",
    status: "finalized",
    token: "SOL",
    amount: "12.5",
    memo: "Render farm credits",
  },
  {
    id: "demo_xfr_acme_request",
    ago: 5 * DAY_MS + 4 * HOUR_MS,
    wallet: "treasury",
    contact: "acme",
    direction: "inbound",
    kind: "request_deposit",
    status: "confirmed",
    token: "USDC",
    amount: "1875.00",
  },
  {
    id: "demo_xfr_onramp_moonpay",
    ago: 11 * DAY_MS,
    wallet: "settlement",
    contact: "jane",
    direction: "inbound",
    type: "onramp",
    kind: "onramp",
    status: "expired",
    token: "USDC",
    amount: "248.10",
    signed: false,
    external: "moonpay:onramp-hot-wallet",
    ramp: {
      provider: "moonpay",
      fiatCurrency: "USD",
      fiatAmount: "250.00",
      providerReference: "demo_mp_tx_31c8",
      deliveryMode: "hosted",
    },
  },
  {
    id: "demo_xfr_orbit_funding",
    ago: 15 * DAY_MS,
    wallet: "treasury",
    contact: "orbit",
    direction: "outbound",
    kind: "pay",
    status: "finalized",
    token: "USDC",
    amount: "25000.00",
    memo: "Payroll funding cycle 18",
  },
  {
    id: "demo_obs_treasury_sol",
    ago: 6 * HOUR_MS + 10 * MINUTE_MS,
    wallet: "treasury",
    direction: "inbound",
    kind: "deposit",
    status: "finalized",
    token: "SOL",
    amount: "2",
    observed: true,
  },
  {
    id: "demo_obs_settlement_sol",
    ago: DAY_MS + 5 * HOUR_MS,
    wallet: "settlement",
    direction: "inbound",
    kind: "deposit",
    status: "finalized",
    token: "SOL",
    amount: "5",
    observed: true,
  },
  {
    id: "demo_obs_payroll_usdc",
    ago: 3 * DAY_MS + 5 * HOUR_MS,
    wallet: "payroll",
    direction: "inbound",
    kind: "deposit",
    status: "finalized",
    token: "USDC",
    amount: "20000.00",
    observed: true,
  },
  {
    id: "demo_obs_treasury_usdc",
    ago: 4 * DAY_MS + 9 * HOUR_MS,
    wallet: "treasury",
    direction: "inbound",
    kind: "deposit",
    status: "finalized",
    token: "USDC",
    amount: "500.00",
    observed: true,
  },
];

interface BatchChunkSpec {
  status: "finalized" | "failed";
  error?: string;
  recipients: ReadonlyArray<readonly [ContactKey, string]>;
}

interface BatchSpec {
  key: string;
  externalId: string;
  wallet: WalletKey;
  ago: number;
  status: PaymentTransferBatchStatus;
  chunks: readonly BatchChunkSpec[];
}

const BATCH_SPECS: readonly BatchSpec[] = [
  {
    key: "contractors_14",
    externalId: "contractor-payouts-run-14",
    wallet: "payroll",
    ago: DAY_MS + 3 * HOUR_MS + 20 * MINUTE_MS,
    status: "confirmed",
    chunks: [
      {
        status: "finalized",
        recipients: [
          ["kai", "950.00"],
          ["priya", "1450.00"],
          ["jane", "600.00"],
        ],
      },
    ],
  },
  {
    key: "vendors_6",
    externalId: "vendor-settlement-run-6",
    wallet: "treasury",
    ago: 4 * DAY_MS + 6 * HOUR_MS,
    status: "partially_failed",
    chunks: [
      {
        status: "finalized",
        recipients: [
          ["acme", "2100.00"],
          ["northwind", "3400.00"],
        ],
      },
      {
        status: "failed",
        error:
          "Recipient token account for USDC is closed. Ask Lumen Studio to reopen it, then retry.",
        recipients: [["lumen", "780.00"]],
      },
    ],
  },
];

interface CycleSpec {
  cycle: number;
  /** A failed automated collection, retried and settled 30 minutes later. */
  failure?: string;
}

interface ScheduleSpec {
  key: string;
  contact: ContactKey;
  wallet: WalletKey;
  amount: string;
  periodHours: number;
  status: PaymentRecurringPaymentStatus;
  /** Signed offsets from `now`. */
  createdAt: number;
  firstCollectionAt: number;
  endedAt?: number;
  cycles: readonly CycleSpec[];
}

const RETRY_DELAY_MS = 30 * MINUTE_MS;

const SCHEDULE_SPECS: readonly ScheduleSpec[] = [
  {
    key: "northwind_supply",
    contact: "northwind",
    wallet: "treasury",
    amount: "8000.00",
    periodHours: 720,
    status: "pending_activation",
    createdAt: -2 * HOUR_MS,
    firstCollectionAt: 5 * DAY_MS,
    cycles: [],
  },
  {
    key: "kai_weekly",
    contact: "kai",
    wallet: "payroll",
    amount: "1200.00",
    periodHours: 168,
    status: "active",
    createdAt: -28 * DAY_MS,
    firstCollectionAt: -(27 * DAY_MS + 3 * HOUR_MS),
    cycles: [
      { cycle: 0 },
      { cycle: 1 },
      {
        cycle: 2,
        failure: "Source wallet balance too low: 842.17 USDC available, 1,200.00 USDC due.",
      },
      { cycle: 3 },
    ],
  },
  {
    key: "lumen_retainer",
    contact: "lumen",
    wallet: "treasury",
    amount: "4500.00",
    periodHours: 720,
    status: "active",
    createdAt: -43 * DAY_MS,
    firstCollectionAt: -42 * DAY_MS + 2 * HOUR_MS,
    cycles: [{ cycle: 0 }, { cycle: 1 }],
  },
  {
    key: "jane_stipend",
    contact: "jane",
    wallet: "settlement",
    amount: "800.00",
    periodHours: 720,
    status: "canceled",
    createdAt: -81 * DAY_MS,
    firstCollectionAt: -80 * DAY_MS,
    endedAt: -35 * DAY_MS,
    cycles: [{ cycle: 0 }, { cycle: 1 }],
  },
];

interface RequestSpec {
  key: string;
  contact: ContactKey | null;
  wallet: WalletKey;
  amount: string;
  status: PaymentRequestStatus;
  createdAgo: number;
  /** Signed offset from `now`, or null for a request that never expires. */
  expiresAt: number | null;
  paidByTransferId?: string;
  canceledAgo?: number;
}

const REQUEST_SPECS: readonly RequestSpec[] = [
  {
    key: "open_invoice",
    contact: null,
    wallet: "treasury",
    amount: "1000.00",
    status: "awaiting_payment",
    createdAgo: 30 * MINUTE_MS,
    expiresAt: null,
  },
  {
    key: "orbit_q4_fees",
    contact: "orbit",
    wallet: "treasury",
    amount: "18250.00",
    status: "awaiting_payment",
    createdAgo: 4 * HOUR_MS,
    expiresAt: 7 * DAY_MS - 4 * HOUR_MS,
  },
  {
    key: "priya_workshop",
    contact: "priya",
    wallet: "settlement",
    amount: "320.00",
    status: "awaiting_payment",
    createdAgo: DAY_MS,
    expiresAt: 2 * DAY_MS,
  },
  {
    key: "lumen_retainer",
    contact: "lumen",
    wallet: "treasury",
    amount: "2400.00",
    status: "paid",
    createdAgo: 3 * DAY_MS,
    expiresAt: 4 * DAY_MS,
    paidByTransferId: "demo_xfr_lumen_request",
  },
  {
    key: "acme_rebill",
    contact: "acme",
    wallet: "treasury",
    amount: "1875.00",
    status: "paid",
    createdAgo: 6 * DAY_MS,
    expiresAt: DAY_MS,
    paidByTransferId: "demo_xfr_acme_request",
  },
  {
    key: "kai_equipment",
    contact: "kai",
    wallet: "payroll",
    amount: "150.00",
    status: "canceled",
    createdAgo: 9 * DAY_MS,
    expiresAt: -2 * DAY_MS,
    canceledAgo: 8 * DAY_MS,
  },
  {
    key: "northwind_deposit",
    contact: "northwind",
    wallet: "treasury",
    amount: "5600.00",
    status: "expired",
    createdAgo: 12 * DAY_MS,
    expiresAt: -5 * DAY_MS,
  },
];

// ─── The demo world ──────────────────────────────────────────────────────────

type DemoWallet = PaymentsDashboardWallet & { balances: CustodyWalletTokenBalance[] };

type DemoTransfer = PaymentTransferSummary & {
  organizationId: string;
  projectId: string;
  type: PaymentTransferType;
  kind: PaymentTransactionKind;
  direction: "inbound" | "outbound";
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

interface DemoTransferRow {
  transfer: DemoTransfer;
  observed: boolean;
}

interface DemoBatch {
  batch: PaymentTransferBatch;
  recipients: PaymentTransferRecipient[];
}

interface DemoWorld {
  wallets: Record<WalletKey, DemoWallet>;
  contacts: Record<ContactKey, Counterparty>;
  accounts: Record<ContactKey, CounterpartyAccount>;
  transfers: DemoTransferRow[];
  batches: DemoBatch[];
  requests: PaymentRequest[];
  schedules: PaymentRecurringPayment[];
  attempts: PaymentSubscriptionCollectionAttempt[];
}

interface Clock {
  /** ISO time `ms` before now. */
  ago: (ms: number) => string;
  /** ISO time at a signed offset from now. */
  at: (offset: number) => string;
}

function createClock(now: Date): Clock {
  // Whole minutes, so every read in one render agrees on the same world.
  const nowMs = Math.floor(now.getTime() / MINUTE_MS) * MINUTE_MS;
  return {
    ago: (ms) => new Date(nowMs - ms).toISOString(),
    at: (offset) => new Date(nowMs + offset).toISOString(),
  };
}

function mapRecord<K extends string, V, R>(
  record: Record<K, V>,
  map: (value: V, key: K) => R
): Record<K, R> {
  return Object.fromEntries(
    (Object.entries(record) as [K, V][]).map(([key, value]) => [key, map(value, key)])
  ) as Record<K, R>;
}

function buildWallet(spec: WalletSpec, key: WalletKey): DemoWallet {
  return {
    id: `demo_cwlt_${key}`,
    walletId: spec.walletId,
    publicKey: demoAddress(`wallet:${key}`),
    label: spec.walletName,
    provider: spec.provider,
    ...spec.owner,
    isRuntimeExecutionAllowed: true,
    balances: spec.holdings.map(([token, amount]) => tokenBalance(token, amount)),
  };
}

function buildContact(spec: ContactSpec, key: ContactKey, clock: Clock): Counterparty {
  return {
    id: `demo_cpty_${key}`,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    externalId: spec.externalId,
    entityType: spec.entityType,
    displayName: spec.displayName,
    status: "active",
    createdBy: CREATED_BY,
    createdAt: clock.ago(spec.createdDaysAgo * DAY_MS),
    updatedAt: clock.ago(spec.createdDaysAgo * DAY_MS - 20 * MINUTE_MS),
  };
}

function buildAccount(spec: ContactSpec, key: ContactKey, clock: Clock): CounterpartyAccount {
  const createdAt = clock.ago(spec.createdDaysAgo * DAY_MS - 5 * MINUTE_MS);
  return {
    id: `demo_cpa_${key}`,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    counterpartyId: `demo_cpty_${key}`,
    accountKind: "crypto_wallet",
    label: spec.accountLabel,
    details: { network: "solana", address: demoAddress(`contact:${key}`) },
    providerAccountData: {},
    status: "active",
    createdAt,
    updatedAt: createdAt,
  };
}

type WorldBase = Pick<DemoWorld, "wallets" | "contacts" | "accounts">;

function otherPartyAddress(spec: TransferSpec, world: WorldBase): string {
  if (spec.external) return demoAddress(spec.external);
  if (spec.contact) return world.accounts[spec.contact].details.address;
  return demoAddress(`external:${spec.id}`);
}

function rampFields(ramp: RampSpec | undefined): Partial<DemoTransfer> {
  if (!ramp) return {};
  return {
    provider: ramp.provider,
    providerReference: ramp.providerReference,
    deliveryMode: ramp.deliveryMode,
    fiatCurrency: ramp.fiatCurrency,
    fiatAmount: ramp.fiatAmount,
  };
}

function buildTransfer(spec: TransferSpec, world: WorldBase, clock: Clock): DemoTransferRow {
  const wallet = world.wallets[spec.wallet];
  const contact = spec.contact ? world.contacts[spec.contact] : undefined;
  const otherParty = otherPartyAddress(spec, world);
  const inbound = spec.direction === "inbound";
  const inFlight = spec.status === "processing" || spec.status === "settling";
  const transfer: DemoTransfer = {
    id: spec.id,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    custodyWalletId: spec.observed ? null : wallet.id,
    providerWalletId: wallet.walletId,
    type: spec.type ?? "transfer",
    kind: spec.kind,
    direction: spec.direction,
    status: spec.status,
    signature: spec.signed === false ? null : demoSignature(spec.id),
    error: spec.error ?? null,
    source: inbound ? otherParty : wallet.publicKey,
    ...(spec.multiRecipient ? {} : { destination: inbound ? wallet.publicKey : otherParty }),
    token: DEMO_TOKENS[spec.token].mint,
    amount: spec.amount,
    ...(spec.memo ? { memo: spec.memo } : {}),
    rampsMemo: spec.rampsMemo ?? {},
    ...(contact
      ? { counterpartyId: contact.id, counterpartyDisplayName: contact.displayName }
      : {}),
    ...rampFields(spec.ramp),
    createdAt: clock.ago(spec.ago),
    updatedAt: clock.ago(inFlight ? spec.ago : Math.max(spec.ago - 2 * MINUTE_MS, 0)),
  };
  return { transfer, observed: spec.observed === true };
}

function batchChunkId(batch: BatchSpec, index: number): string {
  return `demo_xfr_batch_${batch.key}_${index + 1}`;
}

function batchTransferSpecs(): TransferSpec[] {
  return BATCH_SPECS.flatMap((batch) =>
    batch.chunks.map((chunk, index) => ({
      id: batchChunkId(batch, index),
      ago: batch.ago - index * MINUTE_MS,
      wallet: batch.wallet,
      direction: "outbound" as const,
      type: "transfer_batch" as const,
      kind: "batch_pay" as const,
      status: chunk.status,
      token: "USDC" as const,
      amount: sumAmounts(
        chunk.recipients.map(([, amount]) => amount),
        "USDC"
      ),
      multiRecipient: true,
      ...(chunk.error ? { error: chunk.error, signed: false } : {}),
    }))
  );
}

function buildBatch(spec: BatchSpec, world: WorldBase, clock: Clock): DemoBatch {
  const wallet = world.wallets[spec.wallet];
  const batchId = `demo_batch_${spec.key}`;
  const createdAt = clock.ago(spec.ago + MINUTE_MS);
  const updatedAt = clock.ago(Math.max(spec.ago - 3 * MINUTE_MS, 0));
  let position = 0;
  const recipients = spec.chunks.flatMap((chunk, chunkIndex) =>
    chunk.recipients.map(([contact, amount]): PaymentTransferRecipient => {
      position += 1;
      return {
        id: `demo_ptr_${spec.key}_${position}`,
        batchId,
        transferId: batchChunkId(spec, chunkIndex),
        externalId: `${spec.externalId}-${String(position).padStart(3, "0")}`,
        counterpartyId: world.contacts[contact].id,
        counterpartyAccountId: world.accounts[contact].id,
        destination: world.accounts[contact].details.address,
        amount,
        status: chunk.status === "failed" ? "failed" : "confirmed",
        error: chunk.error ?? null,
        createdAt,
        updatedAt,
      };
    })
  );
  return {
    batch: {
      id: batchId,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      externalId: spec.externalId,
      sourceCustodyWalletId: wallet.id,
      sourceProviderWalletId: wallet.walletId,
      sourceAddress: wallet.publicKey,
      token: DEMO_TOKENS.USDC.mint,
      status: spec.status,
      totalAmount: sumAmounts(
        recipients.map((recipient) => recipient.amount),
        "USDC"
      ),
      recipientCount: recipients.length,
      transactionCount: spec.chunks.length,
      createdAt,
      updatedAt,
    },
    recipients,
  };
}

interface ScheduleOutput {
  schedule: PaymentRecurringPayment;
  attempts: PaymentSubscriptionCollectionAttempt[];
  transfers: TransferSpec[];
}

function buildScheduleAttempts(
  spec: ScheduleSpec,
  nowOffset: (offset: number) => string
): Pick<ScheduleOutput, "attempts" | "transfers"> {
  const recurringPaymentId = `demo_rp_${spec.key}`;
  const subscriptionId = `demo_sub_${spec.key}`;
  const periodMs = spec.periodHours * HOUR_MS;
  const attempts: PaymentSubscriptionCollectionAttempt[] = [];
  const transfers: TransferSpec[] = [];
  const base = {
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    subscriptionId,
    token: DEMO_TOKENS.USDC.mint,
    amount: spec.amount,
  };
  const settle = (id: string, dueOffset: number, attemptOffset: number) => {
    const transferId = `demo_xfr_rp_${spec.key}_${transfers.length + 1}`;
    transfers.push({
      id: transferId,
      ago: -attemptOffset,
      wallet: spec.wallet,
      contact: spec.contact,
      direction: "outbound",
      kind: "recurring_pay",
      status: "finalized",
      token: "USDC",
      amount: spec.amount,
    });
    return { id, transferId, dueAt: nowOffset(dueOffset), attemptedAt: nowOffset(attemptOffset) };
  };
  for (const { cycle, failure } of spec.cycles) {
    const dueOffset = spec.firstCollectionAt + cycle * periodMs;
    const attemptId = `demo_psca_${spec.key}_${cycle + 1}`;
    if (failure === undefined) {
      const settled = settle(attemptId, dueOffset, dueOffset + MINUTE_MS);
      attempts.push({
        ...base,
        ...settled,
        status: "confirmed",
        signature: demoSignature(settled.transferId),
        error: null,
        metadata: { source: "automated", recurringPaymentId, initiatedByKeyId: null },
        createdAt: settled.dueAt,
        updatedAt: nowOffset(dueOffset + 2 * MINUTE_MS),
      });
      continue;
    }
    attempts.push({
      ...base,
      id: attemptId,
      transferId: null,
      dueAt: nowOffset(dueOffset),
      attemptedAt: nowOffset(dueOffset + MINUTE_MS),
      status: "failed",
      signature: null,
      error: failure,
      metadata: { source: "automated", recurringPaymentId, initiatedByKeyId: null },
      createdAt: nowOffset(dueOffset),
      updatedAt: nowOffset(dueOffset + MINUTE_MS),
    });
    const retried = settle(`${attemptId}_retry`, dueOffset, dueOffset + RETRY_DELAY_MS + MINUTE_MS);
    attempts.push({
      ...base,
      ...retried,
      status: "confirmed",
      signature: demoSignature(retried.transferId),
      error: null,
      metadata: {
        source: "retry",
        initialSource: "automated",
        transferId: null,
        error: failure,
        retryAfterAt: nowOffset(dueOffset + RETRY_DELAY_MS),
        recurringPaymentId,
        initiatedByKeyId: null,
      },
      createdAt: nowOffset(dueOffset + RETRY_DELAY_MS),
      updatedAt: nowOffset(dueOffset + RETRY_DELAY_MS + 2 * MINUTE_MS),
    });
  }
  return { attempts, transfers };
}

function nextCollectionOffset(spec: ScheduleSpec): number | null {
  if (spec.status === "pending_activation") return spec.firstCollectionAt;
  if (spec.status !== "active") return null;
  const cyclesRun = Math.max(-1, ...spec.cycles.map(({ cycle }) => cycle)) + 1;
  return spec.firstCollectionAt + cyclesRun * spec.periodHours * HOUR_MS;
}

function buildSchedule(spec: ScheduleSpec, world: WorldBase, clock: Clock): ScheduleOutput {
  const wallet = world.wallets[spec.wallet];
  const account = world.accounts[spec.contact];
  const activated = spec.status !== "pending_activation";
  const onchain = (value: string) => (activated ? value : null);
  const { attempts, transfers } = buildScheduleAttempts(spec, clock.at);
  const nextOffset = nextCollectionOffset(spec);
  const lastActivity = attempts.at(-1)?.updatedAt;
  return {
    schedule: {
      id: `demo_rp_${spec.key}`,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      sourceCustodyWalletId: wallet.id,
      sourceProviderWalletId: wallet.walletId,
      sourceAddress: wallet.publicKey,
      counterpartyId: world.contacts[spec.contact].id,
      counterpartyAccountId: account.id,
      destinationAddress: account.details.address,
      destinationTokenAccount: onchain(demoAddress(`token-account:${spec.key}`)),
      token: DEMO_TOKENS.USDC.mint,
      amount: spec.amount,
      periodHours: spec.periodHours,
      firstCollectionAt: clock.at(spec.firstCollectionAt),
      nextCollectionDueAt: nextOffset === null ? null : clock.at(nextOffset),
      planId: onchain(`demo_plan_${spec.key}`),
      subscriptionId: onchain(`demo_sub_${spec.key}`),
      planPda: onchain(demoAddress(`plan:${spec.key}`)),
      planCreatedAt: onchain(clock.at(spec.createdAt + 2 * MINUTE_MS)),
      planCreationSignature: onchain(demoSignature(`plan:${spec.key}`)),
      subscriptionPda: onchain(demoAddress(`subscription:${spec.key}`)),
      subscriptionAuthorityAddress: onchain(demoAddress(`subscription-authority:${spec.key}`)),
      authorizationSignature: onchain(demoSignature(`authorization:${spec.key}`)),
      status: spec.status,
      metadataUri: null,
      createdBy: CREATED_BY,
      createdAt: clock.at(spec.createdAt),
      updatedAt:
        spec.endedAt !== undefined
          ? clock.at(spec.endedAt)
          : (lastActivity ?? clock.at(spec.createdAt)),
    },
    attempts,
    transfers,
  };
}

function buildRequest(
  spec: RequestSpec,
  world: WorldBase,
  transfers: readonly DemoTransferRow[],
  clock: Clock
): PaymentRequest {
  const wallet = world.wallets[spec.wallet];
  const createdAt = clock.ago(spec.createdAgo);
  const paidAt = transfers.find((row) => row.transfer.id === spec.paidByTransferId)?.transfer
    .createdAt;
  const expiresAt = spec.expiresAt === null ? null : clock.at(spec.expiresAt);
  const closedAt =
    spec.status === "paid"
      ? paidAt
      : spec.status === "canceled" && spec.canceledAgo !== undefined
        ? clock.ago(spec.canceledAgo)
        : spec.status === "expired"
          ? (expiresAt ?? undefined)
          : undefined;
  return {
    id: `demo_preq_${spec.key}`,
    publicToken: `demo_pt_${demoAddress(`request-token:${spec.key}`).slice(0, 22)}`,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    counterpartyId: spec.contact ? world.contacts[spec.contact].id : null,
    walletId: wallet.walletId,
    destinationAddress: wallet.publicKey,
    token: DEMO_TOKENS.USDC.mint,
    amount: spec.amount,
    reference: demoAddress(`request-reference:${spec.key}`),
    status: spec.status,
    expiresAt,
    fulfilledByTransferId: spec.status === "paid" ? (spec.paidByTransferId ?? null) : null,
    canceledBy: spec.status === "canceled" ? CREATED_BY : null,
    lifecycle: [
      { status: "awaiting_payment", at: createdAt },
      ...(closedAt === undefined ? [] : [{ status: spec.status, at: closedAt }]),
    ],
    createdBy: CREATED_BY,
    createdAt,
    updatedAt: closedAt ?? createdAt,
  };
}

function newestFirst<T extends { createdAt: string }>(rows: T[]): T[] {
  return rows.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function buildWorld(now: Date): DemoWorld {
  const clock = createClock(now);
  const base: WorldBase = {
    wallets: mapRecord(WALLET_SPECS, (spec: WalletSpec, key) => buildWallet(spec, key)),
    contacts: mapRecord(CONTACT_SPECS, (spec: ContactSpec, key) => buildContact(spec, key, clock)),
    accounts: mapRecord(CONTACT_SPECS, (spec: ContactSpec, key) => buildAccount(spec, key, clock)),
  };
  const scheduleOutputs = SCHEDULE_SPECS.map((spec) => buildSchedule(spec, base, clock));
  const transfers = [
    ...TRANSFER_SPECS,
    ...batchTransferSpecs(),
    ...scheduleOutputs.flatMap((output) => output.transfers),
  ].map((spec) => buildTransfer(spec, base, clock));
  transfers.sort((left, right) => right.transfer.createdAt.localeCompare(left.transfer.createdAt));
  return {
    ...base,
    transfers,
    batches: BATCH_SPECS.map((spec) => buildBatch(spec, base, clock)).sort((left, right) =>
      right.batch.createdAt.localeCompare(left.batch.createdAt)
    ),
    requests: newestFirst(REQUEST_SPECS.map((spec) => buildRequest(spec, base, transfers, clock))),
    schedules: newestFirst(scheduleOutputs.map((output) => output.schedule)),
    attempts: scheduleOutputs.flatMap((output) => output.attempts),
  };
}

// ─── Query helpers ───────────────────────────────────────────────────────────

function positiveInteger(value: string | null, fallback: number): number {
  if (value === null || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return parsed > 0 ? parsed : fallback;
}

interface Page<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

function pageOf<T>(rows: readonly T[], params: URLSearchParams): Page<T> {
  const page = positiveInteger(params.get("page"), 1);
  const pageSize = Math.min(
    positiveInteger(params.get("pageSize"), DEFAULT_PAGE_SIZE),
    MAX_PAGE_SIZE
  );
  return {
    rows: rows.slice((page - 1) * pageSize, page * pageSize),
    total: rows.length,
    page,
    pageSize,
  };
}

function paginatedMeta(page: Page<unknown>) {
  return {
    total: page.total,
    page: page.page,
    pageSize: page.pageSize,
    hasMore: page.page * page.pageSize < page.total,
    requestId: "demo_request",
  };
}

function csv(params: URLSearchParams, key: string): string[] | null {
  const value = params.get(key);
  if (value === null || value.trim() === "") return null;
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function includesSearch(values: ReadonlyArray<string | null | undefined>, search: string): boolean {
  const needle = search.trim().toLowerCase();
  return values.some((value) => value?.toLowerCase().includes(needle) === true);
}

function withinRange(createdAt: string, from: string | null, to: string | null): boolean {
  const time = Date.parse(createdAt);
  if (from !== null && time < Date.parse(from)) return false;
  if (to !== null && time > Date.parse(to)) return false;
  return true;
}

// ─── Wallets ─────────────────────────────────────────────────────────────────

function walletList(world: DemoWorld): DemoWallet[] {
  return Object.values(world.wallets);
}

function findWallet(world: DemoWorld, id: string | null): DemoWallet | undefined {
  return walletList(world).find((wallet) => wallet.id === id || wallet.walletId === id);
}

function walletsBody(world: DemoWorld, params: URLSearchParams) {
  const includeBalances = params.get("includeBalances") === "true";
  return {
    data: {
      wallets: walletList(world).map(({ balances, ...wallet }) =>
        includeBalances ? { ...wallet, balances } : wallet
      ),
    },
  };
}

function aggregateBody(world: DemoWorld) {
  const byMint = new Map<string, { balance: CustodyWalletTokenBalance; amount: bigint }>();
  for (const wallet of walletList(world)) {
    for (const balance of wallet.balances) {
      const current = byMint.get(balance.mint);
      byMint.set(balance.mint, {
        balance,
        amount: (current?.amount ?? 0n) + BigInt(balance.amount),
      });
    }
  }
  const aggregate: CustodyWalletAggregate = {
    walletCount: walletList(world).length,
    balances: [...byMint.values()].map(({ balance, amount }) => {
      const uiAmount = fromBaseUnits(amount, balance.decimals);
      return {
        ...balance,
        amount: amount.toString(),
        uiAmount,
        usdValue: usdValueOf(uiAmount, balance.usdPrice ?? 0),
      };
    }),
  };
  return { data: { aggregate } };
}

function walletsRoute(rest: string[], params: URLSearchParams, world: DemoWorld) {
  if (rest.length === 0) return walletsBody(world, params);
  if (rest.length === 1 && rest[0] === "aggregate") return aggregateBody(world);
  return undefined;
}

function walletBalancesBody(world: DemoWorld, walletId: string) {
  const wallet = findWallet(world, walletId);
  if (!wallet) return undefined;
  return {
    data: {
      walletBalances: { walletId, address: wallet.publicKey, balances: wallet.balances },
    },
  };
}

// ─── Transfers ───────────────────────────────────────────────────────────────

type TransferPredicate = (transfer: DemoTransfer) => boolean;

function transferFilters(params: URLSearchParams): TransferPredicate[] {
  const filters: TransferPredicate[] = [];
  const types = csv(params, "type");
  if (types) filters.push((transfer) => types.includes(transfer.type));
  const statuses = csv(params, "status");
  if (statuses) filters.push((transfer) => statuses.includes(transfer.status));
  const category = params.get("category");
  if (category === "wallet" || category === "ramp") {
    const rampTypes: readonly string[] = ["onramp", "offramp"];
    filters.push((transfer) => rampTypes.includes(transfer.type) === (category === "ramp"));
  }
  for (const key of ["counterpartyId", "direction", "provider", "providerReference"] as const) {
    const value = params.get(key);
    if (value !== null) filters.push((transfer) => transfer[key] === value);
  }
  const token = params.get("token");
  if (token !== null) filters.push((transfer) => matchesToken(transfer.token, token));
  const search = params.get("search");
  if (search !== null && search.trim().length >= 3) {
    filters.push((transfer) =>
      includesSearch(
        [
          transfer.id,
          transfer.signature,
          transfer.providerReference,
          transfer.source,
          transfer.destination,
          transfer.memo,
          transfer.counterpartyId,
          transfer.counterpartyDisplayName,
        ],
        search
      )
    );
  }
  const from = params.get("from");
  const to = params.get("to");
  if (from !== null || to !== null) {
    filters.push((transfer) => withinRange(transfer.createdAt, from, to));
  }
  return filters;
}

/** Which rows a wallet scope lists: its persisted transfers, plus its observed history on request. */
function inTransferScope(
  row: DemoTransferRow,
  wallet: DemoWallet | undefined,
  includeObserved: boolean
): boolean {
  if (!row.observed) return wallet === undefined || row.transfer.custodyWalletId === wallet.id;
  if (!wallet || !includeObserved) return false;
  return row.transfer.destination === wallet.publicKey || row.transfer.source === wallet.publicKey;
}

function transfersBody(world: DemoWorld, params: URLSearchParams) {
  const custodyWalletId = params.get("custodyWalletId");
  const wallet = custodyWalletId === null ? undefined : findWallet(world, custodyWalletId);
  const unknownWallet = custodyWalletId !== null && wallet?.id !== custodyWalletId;
  const includeObserved = params.get("includeObserved") === "true";
  const filters = transferFilters(params);
  const rows = unknownWallet
    ? []
    : world.transfers
        .filter((row) => inTransferScope(row, wallet, includeObserved))
        .map((row) => row.transfer)
        .filter((transfer) => filters.every((filter) => filter(transfer)));
  const page = pageOf(rows, params);
  return { data: page.rows, meta: paginatedMeta(page) };
}

function transferBody(world: DemoWorld, transferId: string) {
  const transfer = world.transfers.find((row) => row.transfer.id === transferId)?.transfer;
  return transfer ? { data: { transfer } } : undefined;
}

// ─── Unified transactions ────────────────────────────────────────────────────

function toUnifiedTransaction(transfer: DemoTransfer, world: DemoWorld): UnifiedTransaction {
  return {
    id: transfer.id,
    moduleId: transfer.id,
    module: "payments",
    kind: transfer.kind,
    moduleStatus: transfer.status,
    status: UNIFIED_TRANSACTION_MODULE_CONTRACTS.payments.status[transfer.status],
    organizationId: transfer.organizationId,
    projectId: transfer.projectId,
    custodyWalletId: transfer.custodyWalletId,
    custodyWalletLabel: findWallet(world, transfer.custodyWalletId)?.label ?? null,
    token: transfer.token ?? null,
    amount: transfer.amount ?? null,
    counterpartyId: transfer.counterpartyId ?? null,
    signature: transfer.signature,
    createdAt: transfer.createdAt,
  };
}

function transactionFilters(params: URLSearchParams): ((row: UnifiedTransaction) => boolean)[] {
  const filters: ((row: UnifiedTransaction) => boolean)[] = [];
  for (const key of ["kind", "status", "custodyWalletId", "counterpartyId"] as const) {
    const value = params.get(key);
    if (value !== null) filters.push((row) => row[key] === value);
  }
  const token = params.get("token");
  if (token !== null) filters.push((row) => matchesToken(row.token, token));
  const search = params.get("search")?.trim().toLowerCase();
  if (search) {
    filters.push((row) =>
      [row.id, row.moduleId, row.signature].some((value) => value?.toLowerCase().startsWith(search))
    );
  }
  const from = params.get("createdAtFrom");
  const to = params.get("createdAtTo");
  if (from !== null || to !== null) filters.push((row) => withinRange(row.createdAt, from, to));
  return filters;
}

function cursorOffset(cursor: string | null): number {
  if (cursor === null || !cursor.startsWith(TRANSACTIONS_CURSOR_PREFIX)) return 0;
  return positiveInteger(cursor.slice(TRANSACTIONS_CURSOR_PREFIX.length), 0);
}

function transactionsBody(world: DemoWorld, params: URLSearchParams) {
  const module = params.get("module");
  const filters = transactionFilters(params);
  const rows =
    module !== null && module !== "payments"
      ? []
      : world.transfers
          .filter((row) => !row.observed)
          .map((row) => toUnifiedTransaction(row.transfer, world))
          .filter((row) => filters.every((filter) => filter(row)));
  const limit = Math.min(
    positiveInteger(params.get("limit"), DEFAULT_TRANSACTIONS_LIMIT),
    MAX_PAGE_SIZE
  );
  const offset = cursorOffset(params.get("cursor"));
  const end = offset + limit;
  return {
    data: {
      transactions: rows.slice(offset, end),
      nextCursor: end < rows.length ? `${TRANSACTIONS_CURSOR_PREFIX}${end}` : null,
    },
  };
}

// ─── Batches, requests, schedules ────────────────────────────────────────────

function batchesBody(world: DemoWorld, params: URLSearchParams) {
  const page = pageOf(
    world.batches.map((entry) => entry.batch),
    params
  );
  return { data: page.rows, meta: paginatedMeta(page) };
}

function batchBody(world: DemoWorld, batchId: string) {
  const entry = world.batches.find((candidate) => candidate.batch.id === batchId);
  if (!entry) return undefined;
  const transferIds = new Set(entry.recipients.map((recipient) => recipient.transferId));
  return {
    data: {
      batch: entry.batch,
      recipients: entry.recipients,
      transfers: world.transfers
        .map((row) => row.transfer)
        .filter((transfer) => transferIds.has(transfer.id)),
    },
  };
}

function requestsBody(world: DemoWorld, params: URLSearchParams) {
  const status = params.get("status");
  const counterpartyId = params.get("counterpartyId");
  const page = pageOf(
    world.requests.filter(
      (request) =>
        (status === null || request.status === status) &&
        (counterpartyId === null || request.counterpartyId === counterpartyId)
    ),
    params
  );
  return {
    data: {
      paymentRequests: page.rows,
      total: page.total,
      page: page.page,
      pageSize: page.pageSize,
    },
  };
}

function recurringPaymentsBody(world: DemoWorld, params: URLSearchParams) {
  const status = params.get("status");
  const counterpartyId = params.get("counterpartyId");
  const page = pageOf(
    world.schedules.filter(
      (schedule) =>
        (status === null || schedule.status === status) &&
        (counterpartyId === null || schedule.counterpartyId === counterpartyId)
    ),
    params
  );
  return {
    data: {
      recurringPayments: page.rows,
      total: page.total,
      page: page.page,
      pageSize: page.pageSize,
    },
  };
}

function recurringPaymentBody(world: DemoWorld, recurringPaymentId: string) {
  const recurringPayment = world.schedules.find((schedule) => schedule.id === recurringPaymentId);
  return recurringPayment ? { data: { recurringPayment } } : undefined;
}

function collectionAttemptsBody(world: DemoWorld, subscriptionId: string, params: URLSearchParams) {
  if (!world.schedules.some((schedule) => schedule.subscriptionId === subscriptionId)) {
    return undefined;
  }
  const attempts = world.attempts
    .filter((attempt) => attempt.subscriptionId === subscriptionId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const page = pageOf(attempts, params);
  return {
    data: {
      collectionAttempts: page.rows,
      total: page.total,
      page: page.page,
      pageSize: page.pageSize,
    },
  };
}

function paymentsRoute(rest: string[], params: URLSearchParams, world: DemoWorld) {
  const [collection, id, child, ...extra] = rest;
  if (extra.length > 0) return undefined;
  if (id === undefined) {
    switch (collection) {
      case "transfers":
        return transfersBody(world, params);
      case "transfer-batches":
        return batchesBody(world, params);
      case "requests":
        return requestsBody(world, params);
      case "recurring-payments":
        return recurringPaymentsBody(world, params);
      default:
        return undefined;
    }
  }
  if (child === undefined) {
    switch (collection) {
      case "transfers":
        return transferBody(world, id);
      case "transfer-batches":
        return batchBody(world, id);
      case "recurring-payments":
        return recurringPaymentBody(world, id);
      default:
        return undefined;
    }
  }
  if (collection === "subscriptions" && child === "collection-attempts") {
    return collectionAttemptsBody(world, id, params);
  }
  if (collection === "wallets" && child === "balances") return walletBalancesBody(world, id);
  return undefined;
}

// ─── Counterparties ──────────────────────────────────────────────────────────

/** Payout accounts providers hold for a few contacts, so a contact's page has rows to show. */
const PROVIDER_ACCOUNT_SPECS: Partial<
  Record<
    ContactKey,
    readonly Pick<
      CounterpartyProviderAccount,
      | "provider"
      | "fiatCurrency"
      | "destinationCountry"
      | "paymentRail"
      | "bankName"
      | "accountNumberLast4"
    >[]
  >
> = {
  jane: [
    {
      provider: "lightspark",
      fiatCurrency: "USD",
      destinationCountry: "US",
      paymentRail: "ACH",
      bankName: "Chase Bank",
      accountNumberLast4: "3321",
    },
  ],
  acme: [
    {
      provider: "lightspark",
      fiatCurrency: "EUR",
      destinationCountry: "DE",
      paymentRail: "SEPA",
      bankName: "Deutsche Bank",
      accountNumberLast4: "8841",
    },
  ],
  northwind: [
    {
      provider: "lightspark",
      fiatCurrency: "GBP",
      destinationCountry: "GB",
      paymentRail: "FPS",
      bankName: "Barclays",
      accountNumberLast4: "5307",
    },
  ],
  lumen: [
    {
      provider: "lightspark",
      fiatCurrency: "USD",
      destinationCountry: "US",
      paymentRail: "WIRE",
      bankName: "Silicon Valley Bank",
      accountNumberLast4: "1188",
    },
  ],
  orbit: [
    {
      provider: "lightspark",
      fiatCurrency: "EUR",
      destinationCountry: "IE",
      paymentRail: "SEPA",
      bankName: "Bank of Ireland",
      accountNumberLast4: "6620",
    },
  ],
  kai: [
    {
      provider: "lightspark",
      fiatCurrency: "USD",
      destinationCountry: "US",
      paymentRail: "ACH",
      bankName: "Wells Fargo",
      accountNumberLast4: "4472",
    },
  ],
  priya: [
    {
      provider: "lightspark",
      fiatCurrency: "USD",
      destinationCountry: "US",
      paymentRail: "ACH",
      bankName: "Bank of America",
      accountNumberLast4: "9015",
    },
  ],
};

function providerAccountsBody(world: DemoWorld, counterparty: Counterparty) {
  const key = (Object.keys(world.contacts) as ContactKey[]).find(
    (contactKey) => world.contacts[contactKey].id === counterparty.id
  );
  const specs = key === undefined ? undefined : PROVIDER_ACCOUNT_SPECS[key];
  const accounts = (specs ?? []).map(
    (spec, index): CounterpartyProviderAccount => ({
      ...spec,
      id: `demo_cppa_${key}_${index}`,
      kind: "payout_account",
      status: "active",
      providerStatus: "VERIFIED",
      createdAt: counterparty.createdAt,
    })
  );
  return { data: { accounts } };
}

function counterpartiesBody(world: DemoWorld, params: URLSearchParams) {
  const page = pageOf(newestFirst(Object.values(world.contacts)), params);
  return {
    data: {
      counterparties: page.rows,
      total: page.total,
      page: page.page,
      pageSize: page.pageSize,
    },
  };
}

function projectAccountsBody(world: DemoWorld, params: URLSearchParams) {
  const ids = csv(params, "ids");
  const search = params.get("search");
  const summaries = newestFirst(Object.values(world.accounts))
    .map(
      (account): CounterpartyAccountSummary => ({
        counterpartyId: account.counterpartyId,
        counterpartyAccountId: account.id,
        name:
          Object.values(world.contacts).find((contact) => contact.id === account.counterpartyId)
            ?.displayName ?? account.counterpartyId,
        address: account.details.address,
        label: account.label,
      })
    )
    .filter(
      (summary) =>
        (ids === null || ids.includes(summary.counterpartyAccountId)) &&
        (search === null ||
          search.trim() === "" ||
          includesSearch([summary.name, summary.address, summary.label], search))
    );
  const page = pageOf(summaries, params);
  return {
    data: { accounts: page.rows, total: page.total, page: page.page, pageSize: page.pageSize },
  };
}

function counterpartyAccountsBody(
  world: DemoWorld,
  counterparty: Counterparty,
  params: URLSearchParams
) {
  const accountKind = params.get("accountKind");
  const page = pageOf(
    Object.values(world.accounts).filter(
      (account) =>
        account.counterpartyId === counterparty.id &&
        (accountKind === null || account.accountKind === accountKind)
    ),
    params
  );
  return {
    data: { accounts: page.rows, total: page.total, page: page.page, pageSize: page.pageSize },
  };
}

function counterpartiesRoute(rest: string[], params: URLSearchParams, world: DemoWorld) {
  const [id, child, ...extra] = rest;
  if (id === undefined) return counterpartiesBody(world, params);
  if (id === "accounts" && child === undefined) return projectAccountsBody(world, params);
  const counterparty = Object.values(world.contacts).find((contact) => contact.id === id);
  if (!counterparty || extra.length > 0) return undefined;
  switch (child) {
    case undefined:
      return { data: { counterparty } };
    case "accounts":
      return counterpartyAccountsBody(world, counterparty, params);
    case "provider-accounts":
      return providerAccountsBody(world, counterparty);
    default:
      return undefined;
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

function emptyIssuedTokensBody(params: URLSearchParams) {
  return { data: [], meta: paginatedMeta(pageOf([], params)) };
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * The JSON body the SDP API would send for this GET (the full envelope, e.g. `{ data: … }`),
 * or undefined to let the request through to the real API.
 */
export function paymentsDemoBody(pathWithQuery: string, now?: Date): unknown | undefined {
  let url: URL;
  try {
    url = new URL(pathWithQuery, "http://demo.local");
  } catch {
    return undefined;
  }
  const [version, resource, ...rest] = url.pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(decodeSegment);
  if (version !== "v1") return undefined;
  const world = buildWorld(now ?? new Date());
  const params = url.searchParams;
  switch (resource) {
    case "wallets":
      return walletsRoute(rest, params, world);
    case "payments":
      return paymentsRoute(rest, params, world);
    case "transactions":
      return rest.length === 0 ? transactionsBody(world, params) : undefined;
    case "counterparties":
      return counterpartiesRoute(rest, params, world);
    case "issuance":
      return rest.length === 1 && rest[0] === "tokens" ? emptyIssuedTokensBody(params) : undefined;
    default:
      return undefined;
  }
}
