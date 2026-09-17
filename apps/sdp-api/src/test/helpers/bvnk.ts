import { buildBvnkOnrampWalletName } from "@sdp/payments/ramps/providers/bvnk/provider-data";
import type { BvnkOnrampTransferProviderData } from "@sdp/payments/ramps/providers/bvnk/schemas";
import type { z } from "zod";
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

/** Display-only on-ramp wallet name in `sdp:onramp:<counterparty>:<fiat>` format. */
export const ONRAMP_WALLET_NAME = buildBvnkOnrampWalletName("cpty_123", "USD");

/**
 * The raw webhook payload shapes SDP handles, as typed by
 * `bvnkWebhookSchema` (pre-transform), so webhook fixtures can never drift
 * from the schema that owns them.
 */
type BvnkWebhookInput = z.input<typeof bvnkWebhookSchema>;

type BvnkWalletStatusChangeData = Extract<
  BvnkWebhookInput,
  { event: "ledger:v2:wallet:status-change" }
>["data"];

export function bvnkWalletStatusChangeEvent(
  overrides?: Partial<BvnkWalletStatusChangeData> & {
    event?: "ledger:v2:wallet:status-change" | "bvnk:ledger:wallet:create";
  }
): Extract<
  BvnkWebhookInput,
  { event: "ledger:v2:wallet:status-change" | "bvnk:ledger:wallet:create" }
> {
  const { event, ...dataOverrides } = overrides === undefined ? {} : overrides;
  return {
    event: event ?? "ledger:v2:wallet:status-change",
    data: {
      id: TEST_BVNK_WALLET_ID,
      status: "ACTIVE",
      paymentInstruments: [
        {
          type: "FIAT",
          accountNumber: "900473221558",
          bankDetails: { bic: "LEADUS49XXX", name: "LEAD BANK" },
        },
      ],
      ...dataOverrides,
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

type BvnkCryptoStatusChangeData = Extract<
  BvnkWebhookInput,
  { event: "bvnk:payment:crypto:status-change" }
>["data"];

export function bvnkCryptoStatusChangeEvent(overrides?: Partial<BvnkCryptoStatusChangeData>): {
  event: "bvnk:payment:crypto:status-change";
  data: BvnkCryptoStatusChangeData;
} {
  return {
    event: "bvnk:payment:crypto:status-change",
    data: {
      status: "COMPLETED",
      type: "OUT",
      uuid: "crypto_1",
      walletId: TEST_BVNK_WALLET_ID,
      reference: "sdp_onramp_xfr_00000000-0000-4000-8000-000000000000",
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

export function bvnkTransferProviderData(
  fundingWalletAccountId: string,
  overrides?: Partial<BvnkOnrampTransferProviderData["bvnk"]>
): BvnkOnrampTransferProviderData {
  return {
    bvnk: {
      fundingWalletAccountId,
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

export function bvnkOnrampProviderDataSeed(input: { offramp?: BvnkOfframpProviderData }): {
  bvnk: { offramp?: BvnkOfframpProviderData };
} {
  return {
    bvnk: {
      ...(input.offramp === undefined ? {} : { offramp: input.offramp }),
    },
  };
}
