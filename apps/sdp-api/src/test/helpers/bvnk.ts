import { BVNK_FUNDING_WALLET_FIAT } from "@sdp/payments/ramps/providers/bvnk/provider-data";
import { buildProcessingSettlement } from "@sdp/payments/ramps/providers/bvnk/settlement";
import type { BvnkRampSettlement } from "@sdp/types";
import {
  BVNK_FUNDING_WALLET_STATUS,
  type BvnkFundingWalletStatus,
  type PaymentTransferStatus,
} from "@sdp/types";
import type { z } from "zod";
import type { AppDb } from "@/db";
import { createPostgresBvnkOnrampTransfersRepository } from "@/db/repositories/bvnk-onramp-transfers.repository.postgres";
import type {
  BvnkCustomerProviderAccountMetadata,
  CounterpartyProviderAccountRow,
} from "@/db/repositories/counterparty-provider-account.repository";
import { createPostgresCounterpartyProviderAccountsRepository } from "@/db/repositories/counterparty-provider-account.repository.postgres";
import type { bvnkWebhookSchema } from "@/routes/webhooks/ramps/bvnk.schema";
import type { Env } from "@/types/env";

export const TEST_BVNK_HAWK_AUTH_ID = "bvnk_hawk_auth_id";

export const TEST_BVNK_HAWK_SECRET_KEY = "bvnk_hawk_secret_key";

export const TEST_BVNK_WALLET_ID = "a:24122329329347:HsdJVhW:1";

export const TEST_BVNK_OFFRAMP_WALLET_ID = "a:99887766554433:OffRmpW:1";

export interface BvnkSandboxEnvValues {
  BVNK_SANDBOX_HAWK_AUTH_ID?: string;
  BVNK_SANDBOX_HAWK_SECRET_KEY?: string;
  BVNK_SANDBOX_WALLET_ID?: string;
}

export interface BvnkSandboxEnvSnapshot {
  BVNK_SANDBOX_HAWK_AUTH_ID: string | undefined;
  BVNK_SANDBOX_HAWK_SECRET_KEY: string | undefined;
  BVNK_SANDBOX_WALLET_ID: string | undefined;
}

export const BVNK_SANDBOX_ENV_DEFAULTS = {
  BVNK_SANDBOX_HAWK_AUTH_ID: TEST_BVNK_HAWK_AUTH_ID,
  BVNK_SANDBOX_HAWK_SECRET_KEY: TEST_BVNK_HAWK_SECRET_KEY,
  BVNK_SANDBOX_WALLET_ID: TEST_BVNK_WALLET_ID,
} satisfies BvnkSandboxEnvValues;

export function stubBvnkSandboxEnv(
  env: Env,
  values?: BvnkSandboxEnvValues
): BvnkSandboxEnvSnapshot {
  const saved: BvnkSandboxEnvSnapshot = {
    BVNK_SANDBOX_HAWK_AUTH_ID: env.BVNK_SANDBOX_HAWK_AUTH_ID,
    BVNK_SANDBOX_HAWK_SECRET_KEY: env.BVNK_SANDBOX_HAWK_SECRET_KEY,
    BVNK_SANDBOX_WALLET_ID: env.BVNK_SANDBOX_WALLET_ID,
  };
  Object.assign(env, { ...BVNK_SANDBOX_ENV_DEFAULTS, ...values });
  return saved;
}

export function restoreBvnkSandboxEnv(env: Env, saved: BvnkSandboxEnvSnapshot): void {
  env.BVNK_SANDBOX_HAWK_AUTH_ID = saved.BVNK_SANDBOX_HAWK_AUTH_ID;
  env.BVNK_SANDBOX_HAWK_SECRET_KEY = saved.BVNK_SANDBOX_HAWK_SECRET_KEY;
  env.BVNK_SANDBOX_WALLET_ID = saved.BVNK_SANDBOX_WALLET_ID;
}

/**
 * The raw webhook payload shapes SDP handles, as typed by
 * `bvnkWebhookSchema` (pre-transform), so webhook fixtures can never drift
 * from the schema that owns them.
 */
type BvnkWebhookInput = z.input<typeof bvnkWebhookSchema>;

/**
 * The observed BVNK envelope timestamp (nanosecond precision, `Z` suffix).
 * Integration suites freeze `Date` to this instant so signed-webhook replay
 * windows judge fixtures as fresh.
 */
export const BVNK_WEBHOOK_TIMESTAMP = "2026-09-18T00:31:17.014444515Z";

type BvnkPlatformCustomerStatusChangeInput = Extract<
  BvnkWebhookInput,
  { event: "bvnk:platform:customer:status-change" }
>;

/**
 * Builds the observed BVNK v2 customer status-change webhook payload.
 *
 * @param overrides - Event fields to replace for a test case.
 * @returns A fully shaped customer status-change event.
 */
export function bvnkPlatformCustomerStatusChangeEvent(
  overrides?: Partial<BvnkPlatformCustomerStatusChangeInput>
): BvnkPlatformCustomerStatusChangeInput {
  return {
    event: "bvnk:platform:customer:status-change",
    eventId: "01a0b1ec-bc16-76e8-a168-d44c4d7d25ad",
    timestamp: BVNK_WEBHOOK_TIMESTAMP,
    data: {
      status: "VERIFIED",
      reference: "customer_1",
    },
    ...overrides,
  };
}

type BvnkWalletStatusChangeData = Extract<
  BvnkWebhookInput,
  { event: "ledger:v2:wallet:status-change" }
>["data"];

export function bvnkWalletStatusChangeEvent(overrides?: Partial<BvnkWalletStatusChangeData>): {
  event: "ledger:v2:wallet:status-change";
  data: BvnkWalletStatusChangeData;
} {
  return {
    event: "ledger:v2:wallet:status-change",
    data: {
      id: "a:synthetic:wallet:1",
      name: "sdp:onramp:cpa_synthetic",
      status: "ACTIVE",
      customer: { id: "customer_1" },
      paymentInstruments: [
        {
          type: "FIAT",
          accountNumber: "900473221558",
          bankDetails: { bic: "LEADUS49XXX", name: "LEAD BANK" },
        },
      ],
      ...overrides,
    },
  };
}

type BvnkV1PayinStatusChangeEvent = Extract<
  BvnkWebhookInput,
  { event: "bvnk:payment:payin:status-change" }
>;

export interface BvnkV1PayinStatusChangeOverrides {
  transactionReference?: string;
  paymentReference?: string;
  additionalRemittanceInformation?: string;
  status?: string;
  amount?: string | number;
  currencyCode?: string;
  walletId?: string;
  customerReference?: string;
  eventId?: string;
}

/**
 * Builds the observed BVNK v1 fiat pay-in status-change webhook payload
 * (Zach, Sep 18): the transaction reference is the pay-in id, the remittance
 * fields carry the transfer reference for attribution, and the amount settles
 * whatever the wallet received.
 *
 * @param overrides - Event data fields to replace.
 * @returns A fully shaped v1 pay-in status-change event.
 */
export function bvnkV1PayinEvent(
  overrides?: BvnkV1PayinStatusChangeOverrides
): BvnkV1PayinStatusChangeEvent {
  const {
    transactionReference = "payin_1",
    paymentReference = "SDP-ONRAMP xfr_1",
    additionalRemittanceInformation,
    status = "COMPLETED",
    amount = 100,
    currencyCode = "USD",
    walletId = "a:1:wallet:1",
    customerReference = "customer_1",
    eventId = "evt_payin_1",
  } = overrides === undefined ? {} : overrides;
  return {
    event: "bvnk:payment:payin:status-change",
    eventId,
    timestamp: BVNK_WEBHOOK_TIMESTAMP,
    data: {
      amount: { value: amount, currencyCode },
      status,
      ...(additionalRemittanceInformation === undefined
        ? {}
        : { metadata: { additionalRemittanceInformation } }),
      beneficiary: { walletId },
      paymentReference,
      customerReference,
      transactionReference,
    },
  };
}

type BvnkV2PayinStatusChangeEvent = Extract<
  BvnkWebhookInput,
  { event: "payment:v2:payin:status-change" }
>;

export interface BvnkV2PayinStatusChangeOverrides {
  id?: string;
  status?: string;
  amount?: string | number;
  currency?: string;
  walletId?: string;
  customerId?: string;
}

/**
 * Builds the legacy BVNK v2 fiat pay-in status-change webhook payload. The v2
 * event is the acknowledged-ignore: it parses so the delivery never 400s, and
 * applying it would double-apply a deposit the v1 event already settled.
 *
 * @param overrides - Event data fields to replace.
 * @returns A fully shaped v2 pay-in status-change event.
 */
export function bvnkV2PayinStatusChangeEvent(
  overrides?: BvnkV2PayinStatusChangeOverrides
): BvnkV2PayinStatusChangeEvent {
  const {
    id = "payin_1",
    status = "COMPLETED",
    amount = 100,
    currency = "USD",
    walletId = "a:1:wallet:1",
    customerId = "customer_1",
  } = overrides === undefined ? {} : overrides;
  return {
    event: "payment:v2:payin:status-change",
    data: {
      id,
      status,
      beneficiary: {
        amount,
        currency,
        walletId,
        customerId,
      },
    },
  };
}

type BvnkCryptoPayoutStatusChangeData = Extract<
  BvnkWebhookInput,
  { event: "bvnk:payment:crypto:status-change" }
>["data"];

const bvnkPayoutMoney = (amount: number, actual: number, currency: string) => ({
  actual,
  amount,
  currency,
});

/**
 * Builds a BVNK crypto payout status-change webhook payload for an on-ramp
 * conversion. The reference IS the transfer id now; the delivered crypto and
 * the full conversion economics let a COMPLETE event settle the transfer end
 * to end. Transactions and the destination address stay optional on the wire
 * and are only required by the schema once the status is COMPLETE/COMPLETED.
 *
 * @param overrides - Event data fields to replace.
 * @returns A fully shaped crypto payout status-change event.
 */
export function bvnkCryptoPayoutStatusChangeEvent(
  overrides?: Partial<BvnkCryptoPayoutStatusChangeData>
): BvnkWebhookInput {
  return {
    event: "bvnk:payment:crypto:status-change",
    data: {
      type: "OUT",
      uuid: "payout_1",
      status: "PROCESSING",
      walletId: "a:1:wallet:1",
      reference: "xfr_bvnk_payout_1",
      address: { address: "dest", network: "SOLANA" },
      paidCurrency: bvnkPayoutMoney(9.8802, 0, "USDC"),
      walletCurrency: bvnkPayoutMoney(9.9, 0, "USD"),
      feeCurrency: bvnkPayoutMoney(0.1, 0, "USD"),
      networkFeeCurrency: bvnkPayoutMoney(0, 0, "USD"),
      exchangeRate: { base: "USD", rate: 0.998, counter: "USDC" },
      transactions: [],
      ...overrides,
    },
  };
}

/**
 * BVNK channel transaction payloads carry far more fields than the webhook
 * schema models (it reads only `reference`/`walletAmount`), so this shape
 * stays local to the fixture module.
 */
interface BvnkChannelTransactionData {
  reference: string;
  channelId: string;
  status: string;
  merchantDisplayName?: string;
  dateCreated?: number;
  lastUpdated?: number;
  uuid?: string;
  hash?: string;
  address?: string;
  paidCurrency?: string;
  displayCurrency?: string;
  walletCurrency?: string;
  feeCurrency?: string;
  paidAmount?: number;
  displayAmount?: number;
  walletAmount?: number;
  feeAmount?: number;
  sources?: string[] | null;
}

const BVNK_CHANNEL_EVENTS = {
  "transaction-detected": "bvnk:payment:channel:transaction-detected",
  "transaction-confirmed": "bvnk:payment:channel:transaction-confirmed",
} as const;

export type BvnkChannelTransactionKind = keyof typeof BVNK_CHANNEL_EVENTS;

export function bvnkChannelTransactionEvent(
  kind: BvnkChannelTransactionKind,
  overrides?: Partial<BvnkChannelTransactionData> & { eventId?: string }
): {
  event: (typeof BVNK_CHANNEL_EVENTS)[BvnkChannelTransactionKind];
  eventId?: string;
  data: BvnkChannelTransactionData;
} {
  const { eventId, ...dataOverrides } = overrides === undefined ? {} : overrides;
  return {
    event: BVNK_CHANNEL_EVENTS[kind],
    ...(eventId === undefined ? {} : { eventId }),
    data: {
      reference: "bvnk-sandbox-test-payment",
      channelId: "channel_1",
      status: kind === "transaction-detected" ? "DETECTED" : "completed",
      ...dataOverrides,
    },
  };
}

type BvnkPlatformCustomerUpdateData = Extract<
  BvnkWebhookInput,
  { event: "bvnk:platform:customer:update" }
>["data"];

export function bvnkPlatformCustomerUpdateEvent(
  overrides?: Partial<BvnkPlatformCustomerUpdateData>
): { event: "bvnk:platform:customer:update"; data: BvnkPlatformCustomerUpdateData } {
  return {
    event: "bvnk:platform:customer:update",
    data: {
      reference: "123e4567-e89b-12d3-a456-426614174000",
      ...overrides,
    },
  };
}

type BvnkAgreementSessionStatusChangeEvent = Extract<
  BvnkWebhookInput,
  { event: "bvnk:platform:customer:agreement-session-status-change" }
>;

/**
 * Builds the observed BVNK agreement-session status-change webhook payload.
 *
 * @param overrides - Event fields to replace for a test case.
 * @returns A fully shaped agreement-session status-change event.
 */
export function bvnkAgreementSessionStatusChangeEvent(
  overrides?: Partial<BvnkAgreementSessionStatusChangeEvent>
): BvnkAgreementSessionStatusChangeEvent {
  return {
    event: "bvnk:platform:customer:agreement-session-status-change",
    eventId: "01a0ab3a-a9cf-7b71-ab7c-f7903f653099",
    timestamp: BVNK_WEBHOOK_TIMESTAMP,
    data: {
      status: "SIGNED",
      reference: "95d360c0-65dd-4598-acc0-89cab6b249da",
    },
    ...overrides,
  };
}

/**
 * Seeds the per-fiat BVNK customer funding wallet row through the repository,
 * so tests never hand-write INSERTs for funding rows. The stored metadata is
 * exactly the caller's input, including deliberately mismatched shapes the
 * repository read path must reject.
 *
 * @param db - Test database receiving the row.
 * @param input - Tenant scope, the funding row's customer reference, the BVNK wallet id, the target status, and the metadata to store.
 * @returns The seeded funding-wallet row in the requested status.
 */
export async function seedBvnkFundingWallet(
  db: AppDb,
  input: {
    organizationId: string;
    projectId: string;
    counterpartyId: string;
    providerCustomerReference: string;
    walletId: string;
    providerStatus: BvnkFundingWalletStatus;
    metadata: Record<string, unknown>;
  }
): Promise<CounterpartyProviderAccountRow> {
  const accounts = createPostgresCounterpartyProviderAccountsRepository(db);
  const scope = {
    organizationId: input.organizationId,
    projectId: input.projectId,
    counterpartyId: input.counterpartyId,
    provider: "bvnk" as const,
  };
  const claimed = await accounts.claimFundingWallet({
    ...scope,
    providerCustomerReference: input.providerCustomerReference,
    fiatCurrency: BVNK_FUNDING_WALLET_FIAT,
    providerStatus: BVNK_FUNDING_WALLET_STATUS.provisioning,
  });
  let row: CounterpartyProviderAccountRow | null = claimed;
  if (row === null) {
    row = await accounts.getAccountByKindAndCurrency({
      ...scope,
      kind: "funding_wallet",
      fiatCurrency: BVNK_FUNDING_WALLET_FIAT,
    });
  }
  if (row === null) {
    throw new Error("BVNK funding wallet claim produced no row.");
  }
  let current = row;
  if (
    input.providerStatus === BVNK_FUNDING_WALLET_STATUS.provisioned &&
    current.external_account_reference === null
  ) {
    const assigned = await accounts.assignFundingWalletReference({
      ...scope,
      id: current.id,
      externalAccountReference: input.walletId,
    });
    if (assigned === null) {
      throw new Error("BVNK funding wallet reference assignment lost its row.");
    }
    current = assigned;
  }
  if (
    input.providerStatus === BVNK_FUNDING_WALLET_STATUS.provisioned &&
    current.provider_status !== BVNK_FUNDING_WALLET_STATUS.provisioned
  ) {
    const updated = await accounts.updateFundingWalletStatus({
      ...scope,
      id: current.id,
      fromStatus: BVNK_FUNDING_WALLET_STATUS.provisioning,
      toStatus: BVNK_FUNDING_WALLET_STATUS.provisioned,
    });
    if (updated === null) {
      throw new Error("BVNK funding wallet provision CAS lost its row.");
    }
    current = updated;
  }
  if (JSON.stringify(current.metadata) !== JSON.stringify(input.metadata)) {
    await db
      .prepare("UPDATE counterparty_provider_accounts SET metadata = ? WHERE id = ?")
      .bind(input.metadata, current.id)
      .run();
    const updated = await accounts.getAccountByKindAndCurrency({
      ...scope,
      kind: "funding_wallet",
      fiatCurrency: BVNK_FUNDING_WALLET_FIAT,
    });
    if (updated === null) {
      throw new Error("BVNK funding wallet metadata update lost its row.");
    }
    return updated;
  }
  return current;
}

/**
 * Seeds a BVNK on-ramp transfer row for webhook, cancel, and simulation
 * tests, shaped like the prebooked row the quote path writes: the provider
 * reference is the transfer id, delivery mode is manual instructions, and
 * provider_data starts as `{ bvnk: {} }` (R1). The custody wallet id binding
 * the transfer to an API-key-accessible wallet and the provider_data payload
 * are caller-controlled so authz, pay-in replay, and payout webhook tests can
 * seed exactly the state they exercise.
 *
 * @param db - Test database receiving the row.
 * @param input - Tenant scope, transfer id and status, the fiat/destination
 *   values the quote prebooked, the optional custody wallet id, and the
 *   optional provider_data payload.
 * @returns Nothing once the transfer row exists.
 */
export async function seedBvnkOnrampTransfer(
  db: AppDb,
  input: {
    id: string;
    status: PaymentTransferStatus;
    counterpartyId: string;
    organizationId: string;
    projectId: string;
    fiatAmount: string;
    destinationAddress: string;
    custodyWalletId?: string;
    providerData?: Record<string, unknown>;
  }
): Promise<void> {
  const now = new Date().toISOString();
  const custodyWalletId = input.custodyWalletId === undefined ? null : input.custodyWalletId;
  const providerData = input.providerData === undefined ? { bvnk: {} } : input.providerData;
  await db
    .prepare(
      `INSERT INTO payment_transfers (
         id, organization_id, project_id, wallet_id, custody_wallet_id, source_address,
         destination_address, token, amount, memo, type, direction, status, provider,
         provider_reference, delivery_mode, fiat_currency, fiat_amount, counterparty_id,
         provider_data, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)`
    )
    .bind(
      input.id,
      input.organizationId,
      input.projectId,
      "wallet_bvnk_onramp_seed",
      custodyWalletId,
      null,
      input.destinationAddress,
      "USDC",
      null,
      null,
      "onramp",
      "inbound",
      input.status,
      "bvnk",
      input.id,
      "manual_instructions",
      "USD",
      input.fiatAmount,
      input.counterpartyId,
      providerData,
      now,
      now
    )
    .run();
}

/**
 * Derives the BVNK customer reference a seeded counterparty's customer link
 * stores: deterministic and unique per counterparty (the counterparty id is
 * `cpty_<name>`), so no two seeds can collide on the
 * `(provider, provider_customer_reference)` uniqueness of active customer
 * links. Webhook fixtures that must match the seeded link use this same
 * builder.
 *
 * @param name - The seed's name suffix (the counterparty id sans `cpty_`).
 * @returns The BVNK customer reference stored on the seeded customer link.
 */
export function bvnkSeedCustomerReference(name: string): string {
  return `customer_${name}`;
}

/**
 * Seeds a counterparty, its BVNK customer link, and its provisioned USD
 * funding wallet in one call — the tenant scope every BVNK on-ramp flow
 * (webhook, cancel, simulate, reconciler) starts from. The funding wallet row
 * is created through `seedBvnkFundingWallet` so the claim/assign transitions
 * run exactly like production. The customer link reference is derived from
 * the counterparty id (see {@link bvnkSeedCustomerReference}), never shared
 * between seeds.
 *
 * @param db - Test database receiving the rows.
 * @param input - Tenant scope and a name suffix for stable ids.
 * @returns The counterparty id and the funding wallet reference.
 */
export async function seedBvnkOnrampCounterpartyAndFundingWallet(
  db: AppDb,
  input: {
    organizationId: string;
    projectId: string;
    name: string;
    fundingWalletReference: string;
    createdBy: string;
  }
): Promise<{ counterpartyId: string; fundingReference: string }> {
  const counterpartyId = `cpty_${input.name}`;
  const providerCustomerReference = bvnkSeedCustomerReference(input.name);
  await db
    .prepare(
      `INSERT INTO counterparties (
         id, organization_id, project_id, entity_type, display_name, provider_data, created_by
       ) VALUES (?, ?, ?, 'individual', ?, '{}', ?)`
    )
    .bind(counterpartyId, input.organizationId, input.projectId, input.name, input.createdBy)
    .run();
  await db
    .prepare(
      `INSERT INTO counterparty_provider_accounts (
         id, organization_id, project_id, counterparty_id, provider,
         provider_customer_reference, kind, fiat_currency, external_account_reference,
         provider_status, status, metadata
       ) VALUES (?, ?, ?, ?, 'bvnk', ?, 'customer_link', NULL, NULL, NULL, 'active', '{}')`
    )
    .bind(
      `cpa_link_${input.name}`,
      input.organizationId,
      input.projectId,
      counterpartyId,
      providerCustomerReference
    )
    .run();
  await seedBvnkFundingWallet(db, {
    organizationId: input.organizationId,
    projectId: input.projectId,
    counterpartyId,
    providerCustomerReference,
    walletId: input.fundingWalletReference,
    providerStatus: BVNK_FUNDING_WALLET_STATUS.provisioned,
    metadata: {},
  });
  return { counterpartyId, fundingReference: input.fundingWalletReference };
}

/** The pay-in facts a seeded on-ramp transfer owns; every field is written by the caller (no defaults). */
export interface SeedBvnkOnrampPayin {
  id: string;
  receivedAmount: string;
  receivedCurrency: string;
  walletId: string;
  customerId: string;
}

export interface SeedBvnkOnrampPayinAppliedInput {
  organizationId: string;
  projectId: string;
  name: string;
  createdBy: string;
  fundingWalletReference: string;
  transferId: string;
  destinationAddress: string;
  payin: SeedBvnkOnrampPayin;
}

/**
 * Seeds a BVNK on-ramp transfer through the REAL transitions: the funding
 * scope, an awaiting transfer, then `applyPayin` with the caller's pay-in
 * facts. The transfer ends `settling` with the pay-in ownership blob exactly
 * as the webhook writes it, so seeded rows always pass the strict codec and
 * the unique pay-in index stays honest (callers supply distinct payin ids).
 *
 * @param db - Test database receiving the rows.
 * @param input - Tenant scope, transfer identity, destination, and the pay-in facts.
 * @returns The settling transfer row.
 */
export async function seedBvnkOnrampPayinApplied(
  db: AppDb,
  input: SeedBvnkOnrampPayinAppliedInput
): Promise<import("@/db/repositories/payments.repository").PaymentTransferRow> {
  const { counterpartyId } = await seedBvnkOnrampCounterpartyAndFundingWallet(db, input);
  await seedBvnkOnrampTransfer(db, {
    id: input.transferId,
    status: "awaiting_payment",
    counterpartyId,
    organizationId: input.organizationId,
    projectId: input.projectId,
    fiatAmount: input.payin.receivedAmount,
    destinationAddress: input.destinationAddress,
  });
  const repo = createPostgresBvnkOnrampTransfersRepository(db);
  const applied = await repo.applyPayin({
    transferId: input.transferId,
    fundingWalletReference: input.fundingWalletReference,
    payin: input.payin,
  });
  if (applied === null) {
    throw new Error(`BVNK on-ramp pay-in apply failed for ${input.transferId}.`);
  }
  return applied;
}

export interface SeedBvnkOnrampPayoutClaimedInput extends SeedBvnkOnrampPayinAppliedInput {
  claimedAt: string;
  intent: {
    amount: string;
    currency: string;
    cryptoCurrency: string;
    network: string;
    address: string;
  };
}

/**
 * Seeds a settling transfer that owns its pay-in AND its payout claim, via
 * the real `applyPayin` + `claimPayout` transitions.
 *
 * @param db - Test database receiving the rows.
 * @param input - The pay-in seed input plus the claim timestamp and spend intent.
 * @returns The claimed transfer row.
 */
export async function seedBvnkOnrampPayoutClaimed(
  db: AppDb,
  input: SeedBvnkOnrampPayoutClaimedInput
): Promise<import("@/db/repositories/payments.repository").PaymentTransferRow> {
  await seedBvnkOnrampPayinApplied(db, input);
  const repo = createPostgresBvnkOnrampTransfersRepository(db);
  const claimed = await repo.claimPayout({
    transferId: input.transferId,
    claimedAt: input.claimedAt,
    intent: input.intent,
  });
  if (claimed === null) {
    throw new Error(`BVNK on-ramp payout claim failed for ${input.transferId}.`);
  }
  return claimed;
}

export interface SeedBvnkOnrampPayoutIssuedInput extends SeedBvnkOnrampPayoutClaimedInput {
  environment: "sandbox" | "production";
  payoutId: string;
}

/**
 * Seeds a settling transfer whose payout is claimed AND issued, via the real
 * `applyPayin` + `claimPayout` + `recordPayoutId` transitions (the latter
 * lands the PROCESSING settlement alongside the payout id, exactly like the
 * reconciler).
 *
 * @param db - Test database receiving the rows.
 * @param input - The claim seed input plus the project environment and the provider payout id.
 * @returns The issued transfer row.
 */
export async function seedBvnkOnrampPayoutIssued(
  db: AppDb,
  input: SeedBvnkOnrampPayoutIssuedInput
): Promise<import("@/db/repositories/payments.repository").PaymentTransferRow> {
  await seedBvnkOnrampPayoutClaimed(db, input);
  const repo = createPostgresBvnkOnrampTransfersRepository(db);
  const summary = bvnkPayoutSummary({ uuid: input.payoutId, reference: input.transferId });
  if (summary.redirectUrl === undefined) {
    throw new Error("seedBvnkOnrampPayoutIssued fixture summary lacks the receipt url.");
  }
  return repo.recordPayoutId({
    transferId: input.transferId,
    payoutId: input.payoutId,
    claimedAt: input.claimedAt,
    environment: input.environment,
    settlement: buildProcessingSettlement(input.payin.id, summary, summary.redirectUrl),
  });
}

/** Overridable parts of a payout summary fixture; every default matches the typed wire shape. */
export type BvnkPayoutSummaryOverrides = Partial<
  import("@sdp/payments/ramps/providers/bvnk/schemas").BvnkOnrampPayoutSummary
>;

/**
 * Builds a BK estimator-free provider payout summary with the full typed
 * shape (including `walletId` and `type`, which adoption and the poll path
 * validate), so mocked provider responses can never drift from the schema
 * that owns them.
 *
 * @param overrides - Summary fields to replace for a test case.
 * @returns A fully shaped payout summary.
 */
export function bvnkPayoutSummary(
  overrides: BvnkPayoutSummaryOverrides = {}
): import("@sdp/payments/ramps/providers/bvnk/schemas").BvnkOnrampPayoutSummary {
  return {
    uuid: "payout_uuid_1",
    type: "OUT",
    walletId: "a:wallet:bvnk:1",
    status: "PROCESSING",
    quoteStatus: "ACCEPTED",
    reference: "xfr_payout_1",
    redirectUrl: "https://pay.sandbox.bvnk.com/payout/payout_uuid_1",
    walletCurrency: { currency: "USD", amount: 100, actual: 0 },
    paidCurrency: { currency: "USDC", amount: 99.8, actual: 0 },
    feeCurrency: { currency: "USD", amount: 0.2, actual: 0 },
    networkFeeCurrency: { currency: "USD", amount: 0, actual: 0 },
    exchangeRate: { base: "USD", counter: "USDC", rate: 0.998 },
    ...overrides,
  };
}

/**
 * The PROCESSING settlement blob the reconciler records at payout create,
 * derived through the real builder from the fixture summary. Seeds that call
 * `recordPayoutId` (directly or via `seedBvnkOnrampPayoutIssued`) must pass a
 * blob built the same way the reconcile path builds it.
 *
 * @param transferId - The transfer id the settlement anchors.
 * @param payoutId - The provider payout id the settlement records.
 * @returns The PROCESSING settlement blob.
 */
export function bvnkProcessingSettlement(transferId: string, payoutId: string): BvnkRampSettlement {
  const summary = bvnkPayoutSummary({ uuid: payoutId, reference: transferId });
  if (summary.redirectUrl === undefined) {
    throw new Error("bvnkProcessingSettlement fixture summary lacks the receipt url.");
  }
  return buildProcessingSettlement(`payin_${transferId}`, summary, summary.redirectUrl);
}

/**
 * The BVNK off-ramp marker stored under
 * `counterparties.provider_data.bvnk.offramp`; no zod schema models
 * provider_data in the API, so the shape stays local.
 */
export interface BvnkOfframpProviderData {
  wallets: Record<string, { id: string; status: string }>;
  beneficiaries?: Record<
    string,
    { key: string; fiatCurrency: string; accountType: string; createdAt: string }
  >;
}

export function bvnkCustomerLinkSeed(
  ref: string,
  metadata?: BvnkCustomerProviderAccountMetadata
): { provider: "bvnk"; providerCustomerReference: string; metadata?: Record<string, unknown> } {
  return {
    provider: "bvnk",
    providerCustomerReference: ref,
    ...(metadata === undefined ? {} : { metadata }),
  };
}
