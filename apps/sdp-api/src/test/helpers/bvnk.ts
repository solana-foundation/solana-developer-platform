import {
  type BvnkOnrampRequestSpec,
  buildBvnkOnrampWalletName,
} from "@sdp/payments/ramps/providers/bvnk/provider-data";
import type { BvnkOnrampTransferProviderData } from "@sdp/payments/ramps/providers/bvnk/schemas";
import type { z } from "zod";
import type { BvnkCustomerProviderAccountMetadata } from "@/db/repositories/counterparty-provider-account.repository";
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

const ONRAMP_KEY = "USD:USDC_SOLANA:dest";

const ONRAMP_WALLET_NAME = buildBvnkOnrampWalletName("cpty_123", ONRAMP_KEY);

/**
 * The raw webhook payload shapes SDP handles, as typed by
 * `bvnkWebhookSchema` (pre-transform), so webhook fixtures can never drift
 * from the schema that owns them.
 */
type BvnkWebhookInput = z.input<typeof bvnkWebhookSchema>;

type BvnkCustomerStatusChangeData = Extract<
  BvnkWebhookInput,
  { event: "bvnk:customers:status-change" }
>["data"];

export function bvnkCustomerStatusChangeEvent(overrides?: Partial<BvnkCustomerStatusChangeData>): {
  event: "bvnk:customers:status-change";
  data: BvnkCustomerStatusChangeData;
} {
  return {
    event: "bvnk:customers:status-change",
    data: {
      customerId: "customer_1",
      status: "VERIFIED",
      ...overrides,
    },
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
      name: ONRAMP_WALLET_NAME,
      status: "ACTIVE",
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
  { event: "bvnk:payment:payin:status-change" }
>["data"];

export function bvnkPayinStatusChangeEvent(overrides?: Partial<BvnkPayinStatusChangeData>): {
  event: "bvnk:payment:payin:status-change";
  data: BvnkPayinStatusChangeData;
} {
  return {
    event: "bvnk:payment:payin:status-change",
    data: {
      status: "COMPLETED",
      customerReference: "customer_1",
      amount: { value: 100 },
      beneficiary: { walletId: "a:1:wallet:1" },
      uuid: "payin_1",
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
    timestamp: new Date().toISOString(),
    data: {
      status: "SIGNED",
      reference: "95d360c0-65dd-4598-acc0-89cab6b249da",
    },
    ...overrides,
  };
}

export function bvnkOnrampRequest(
  overrides?: Partial<BvnkOnrampRequestSpec>
): BvnkOnrampRequestSpec {
  return {
    fiatCurrency: "USD",
    currency: "USDC",
    network: "SOLANA",
    destinationWalletAddress: "dest",
    ...overrides,
  };
}

/**
 * The BVNK customer cached on `counterparties.provider_data.bvnk.customer`;
 * no zod schema models provider_data in the API, so the shape stays local.
 */
export interface BvnkCachedCustomer {
  customerReference: string;
  externalReference?: string;
  status: string;
}

export function bvnkCachedCustomerSeed(
  ref: string,
  overrides?: Partial<BvnkCachedCustomer>
): BvnkCachedCustomer {
  return {
    customerReference: ref,
    status: "PENDING",
    ...overrides,
  };
}

export function bvnkTransferProviderData(
  ruleId: string,
  fundingWalletId: string,
  overrides?: Partial<BvnkOnrampTransferProviderData["bvnk"]>
): BvnkOnrampTransferProviderData {
  return {
    bvnk: {
      ruleId,
      fundingWalletId,
      ...overrides,
    },
  };
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

export type BvnkOnrampProviderData = {
  bvnk: {
    customer?: BvnkCachedCustomer;
    wallets?: Record<string, Record<string, unknown>>;
    offramp?: BvnkOfframpProviderData;
  };
};

export function bvnkOnrampProviderDataSeed(input: {
  customer?: BvnkCachedCustomer;
  wallets?: Record<string, unknown>;
  offramp?: BvnkOfframpProviderData;
  onrampKey?: string;
}): BvnkOnrampProviderData {
  return {
    bvnk: {
      ...(input.customer === undefined ? {} : { customer: input.customer }),
      ...(input.wallets === undefined
        ? {}
        : {
            wallets: {
              [input.onrampKey === undefined ? ONRAMP_KEY : input.onrampKey]: input.wallets,
            },
          }),
      ...(input.offramp === undefined ? {} : { offramp: input.offramp }),
    },
  };
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
