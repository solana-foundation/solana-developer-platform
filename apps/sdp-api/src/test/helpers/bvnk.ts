import { BVNK_FUNDING_WALLET_FIAT } from "@sdp/payments/ramps/providers/bvnk/provider-data";
import {
  BVNK_FUNDING_WALLET_STATUS,
  type BvnkFundingWalletStatus,
  type PaymentTransferStatus,
} from "@sdp/types";
import type { z } from "zod";
import type { AppDb } from "@/db";
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

type BvnkPayinStatusChangeData = Extract<
  BvnkWebhookInput,
  { event: "payment:v2:payin:status-change" }
>["data"];

/**
 * Builds the observed BVNK v2 fiat pay-in status-change webhook payload.
 *
 * @param overrides - Event data fields to replace.
 * @returns A fully shaped pay-in status-change event.
 */
export function bvnkPayinStatusChangeEvent(
  overrides?: Partial<BvnkPayinStatusChangeData>
): BvnkWebhookInput {
  const dataOverrides = overrides === undefined ? {} : overrides;
  return {
    event: "payment:v2:payin:status-change",
    data: {
      id: "payin_1",
      status: "COMPLETED",
      beneficiary: {
        amount: 100,
        currency: "USD",
        walletId: "a:1:wallet:1",
        customerId: "customer_1",
      },
      ...dataOverrides,
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
 * conversion, carrying the full conversion economics so a COMPLETE event can
 * settle the transfer end to end.
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
      reference: "ON_RAMP_payin_1",
      address: { address: "dest", network: "SOLANA" },
      paidCurrency: bvnkPayoutMoney(9.8802, 0, "USDC"),
      walletCurrency: bvnkPayoutMoney(9.9, 0, "USD"),
      feeCurrency: bvnkPayoutMoney(0.1, 0, "USD"),
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
    input.providerStatus !== BVNK_FUNDING_WALLET_STATUS.provisioning &&
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
    (input.providerStatus === BVNK_FUNDING_WALLET_STATUS.provisioned ||
      input.providerStatus === BVNK_FUNDING_WALLET_STATUS.locked) &&
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
  if (input.providerStatus === BVNK_FUNDING_WALLET_STATUS.locked) {
    const transferId = input.metadata.transferId;
    if (typeof transferId !== "string" || transferId.length === 0) {
      throw new Error("seedBvnkFundingWallet requires a transferId in metadata for a locked row.");
    }
    const locked = await accounts.lockFundingWallet({
      ...scope,
      id: current.id,
      transferId,
    });
    if (locked === null) {
      throw new Error("BVNK funding wallet lock CAS lost its row.");
    }
    current = locked;
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
 * Seeds a BVNK on-ramp transfer row for lock and cancel tests, shaped like the
 * prebooked row the quote path writes: the provider reference is the transfer
 * id and delivery mode is manual instructions.
 *
 * @param db - Test database receiving the row.
 * @param input - Tenant scope, transfer id and status, and the fiat/destination values the quote locked.
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
  }
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO payment_transfers (
         id, organization_id, project_id, wallet_id, source_address, destination_address,
         token, amount, memo, type, direction, status, provider, provider_reference,
         delivery_mode, fiat_currency, fiat_amount, counterparty_id, provider_data,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?)`
    )
    .bind(
      input.id,
      input.organizationId,
      input.projectId,
      "wallet_bvnk_onramp_seed",
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
      {},
      now,
      now
    )
    .run();
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
