import {
  type BvnkRampSettlement,
  type CoinbaseRampSettlement,
  type LightsparkRampSettlement,
  type MoonpayRampSettlement,
  type PaymentTransferSummary,
  SDP_ENVIRONMENT_BY_CLUSTER,
  type SdpEnvironment,
  type SolanaCluster,
} from "@sdp/types";
import type { RampProviderId } from "@sdp/types/provider-access";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import { explorerTxUrl } from "@/lib/explorer";
import {
  formatDisplayAmount,
  formatMinorCurrencyAmount,
  shortenAddress,
} from "./payments-overview.utils";

type Translate = (key: MessageKey, values?: TranslationValues) => string;
type RampTransferDirection = "onramp" | "offramp";

interface TransferDetailFieldContext {
  cluster: SolanaCluster;
}

/**
 * One declared detail field. The spec list per provider is the maintained
 * surface — add a field by adding an entry, never by touching the renderer.
 * A field whose accessor returns null is omitted for that transfer.
 */
type TransferDetailFieldSpec<TSettlement> =
  | {
      kind: "text";
      labelKey: MessageKey;
      text: (settlement: TSettlement) => string | null;
    }
  | {
      kind: "link";
      labelKey: MessageKey;
      textKey: MessageKey;
      href: (settlement: TSettlement, context: TransferDetailFieldContext) => string | null;
    }
  | {
      kind: "explorerTx";
      labelKey: MessageKey;
      signature: (settlement: TSettlement) => string | null;
    };

export interface ProviderTransferDetailRow {
  key: MessageKey;
  label: string;
  value: string;
  /** Renders the value as an external link. */
  href?: string;
  copyValue?: string;
  mono?: boolean;
}

function moonpayTrackerUrl(transactionId: string): string {
  return `https://buy.moonpay.com/v2/transaction-tracker?transactionId=${encodeURIComponent(transactionId)}`;
}

/**
 * The BVNK-hosted payout receipt for one payout, derived per environment and
 * never stored.
 *
 * @param payoutId - The BVNK payout id (the crypto payout webhook's `uuid`).
 * @param environment - Sandbox or production ramp environment.
 * @returns The hosted receipt URL.
 */
export function bvnkPayoutReceiptUrl(payoutId: string, environment: SdpEnvironment): string {
  const host = environment === "sandbox" ? "pay.sandbox.bvnk.com" : "pay.bvnk.com";
  return `https://${host}/payout/${encodeURIComponent(payoutId)}`;
}

const MOONPAY_FIELDS: readonly TransferDetailFieldSpec<MoonpayRampSettlement>[] = [
  {
    kind: "text",
    labelKey: "DashboardPayments.transferDetails.providerFee",
    text: (settlement) =>
      formatDisplayAmount(String(settlement.feeAmount), settlement.baseCurrencyCode),
  },
  {
    kind: "text",
    labelKey: "DashboardPayments.transferDetails.networkFee",
    text: (settlement) =>
      settlement.networkFeeAmount > 0
        ? formatDisplayAmount(String(settlement.networkFeeAmount), settlement.baseCurrencyCode)
        : null,
  },
  {
    kind: "text",
    labelKey: "DashboardPayments.transferDetails.exchangeRate",
    text: (settlement) =>
      settlement.quoteCurrencyAmount > 0
        ? `1 ${settlement.quoteCurrencyCode} = ${formatDisplayAmount(
            (settlement.baseCurrencyAmount / settlement.quoteCurrencyAmount).toFixed(2),
            settlement.baseCurrencyCode
          )}`
        : null,
  },
  {
    kind: "explorerTx",
    labelKey: "DashboardPayments.transferDetails.solanaSignature",
    signature: (settlement) =>
      settlement.cryptoTransactionId === undefined ? null : settlement.cryptoTransactionId,
  },
];

const COINBASE_FIELDS: readonly TransferDetailFieldSpec<CoinbaseRampSettlement>[] = [
  {
    kind: "text",
    labelKey: "DashboardPayments.transferDetails.providerFee",
    text: (settlement) => {
      const fee = settlement.fees.find((entry) => entry.feeType === "FEE_TYPE_EXCHANGE");
      return fee ? formatDisplayAmount(fee.feeAmount, fee.feeCurrency) : null;
    },
  },
  {
    kind: "text",
    labelKey: "DashboardPayments.transferDetails.networkFee",
    text: (settlement) => {
      const fee = settlement.fees.find((entry) => entry.feeType === "FEE_TYPE_NETWORK");
      return fee && Number(fee.feeAmount) > 0
        ? formatDisplayAmount(fee.feeAmount, fee.feeCurrency)
        : null;
    },
  },
  {
    kind: "text",
    labelKey: "DashboardPayments.transferDetails.exchangeRate",
    text: (settlement) =>
      `1 ${settlement.purchaseCurrency} = ${formatDisplayAmount(
        settlement.exchangeRate,
        settlement.paymentCurrency
      )}`,
  },
];

const BVNK_FIELDS: readonly TransferDetailFieldSpec<BvnkRampSettlement>[] = [
  {
    kind: "text",
    labelKey: "DashboardPayments.transferDetails.providerFee",
    text: (settlement) => formatDisplayAmount(settlement.feeAmount, settlement.feeCurrency),
  },
  {
    kind: "text",
    labelKey: "DashboardPayments.transferDetails.exchangeRate",
    text: (settlement) =>
      `1 ${settlement.fiatCurrency} = ${formatDisplayAmount(
        String(settlement.exchangeRate),
        settlement.cryptoCurrency
      )}`,
  },
  {
    kind: "text",
    labelKey: "DashboardPayments.transferDetails.delivered",
    text: (settlement) => formatDisplayAmount(settlement.cryptoAmount, settlement.cryptoCurrency),
  },
  {
    kind: "explorerTx",
    labelKey: "DashboardPayments.transferDetails.solanaSignature",
    signature: (settlement) => settlement.txHash,
  },
];

const LIGHTSPARK_FIELDS: readonly TransferDetailFieldSpec<LightsparkRampSettlement>[] = [
  {
    kind: "text",
    labelKey: "DashboardPayments.transferDetails.fees",
    text: (settlement) =>
      formatMinorCurrencyAmount(
        settlement.fees,
        settlement.sentAmount.currencyCode,
        settlement.sentAmount.decimals
      ),
  },
  {
    kind: "text",
    labelKey: "DashboardPayments.transferDetails.exchangeRate",
    text: (settlement) => {
      const sent = settlement.sentAmount.amount / 10 ** settlement.sentAmount.decimals;
      const received = settlement.receivedAmount.amount / 10 ** settlement.receivedAmount.decimals;
      return received > 0
        ? `1 ${settlement.receivedAmount.currencyCode} = ${(sent / received).toFixed(4)} ${settlement.sentAmount.currencyCode}`
        : null;
    },
  },
];

function rowsFromSpecs<TSettlement>(
  specs: readonly TransferDetailFieldSpec<TSettlement>[],
  settlement: TSettlement,
  context: TransferDetailFieldContext,
  t: Translate
): ProviderTransferDetailRow[] {
  const rows: ProviderTransferDetailRow[] = [];
  for (const spec of specs) {
    switch (spec.kind) {
      case "text": {
        const text = spec.text(settlement);
        if (text !== null) {
          rows.push({ key: spec.labelKey, label: t(spec.labelKey), value: text });
        }
        break;
      }
      case "link": {
        const href = spec.href(settlement, context);
        if (href !== null) {
          rows.push({
            key: spec.labelKey,
            label: t(spec.labelKey),
            value: t(spec.textKey),
            href,
          });
        }
        break;
      }
      case "explorerTx": {
        const signature = spec.signature(settlement);
        if (signature !== null) {
          rows.push({
            key: spec.labelKey,
            label: t(spec.labelKey),
            value: shortenAddress(signature),
            href: explorerTxUrl(signature, context.cluster),
            copyValue: signature,
            mono: true,
          });
        }
        break;
      }
      default: {
        const exhaustive: never = spec;
        throw new Error(`Unhandled transfer detail field kind: ${String(exhaustive)}`);
      }
    }
  }
  return rows;
}

type ProviderRowBuilder = (
  transfer: PaymentTransferSummary,
  context: TransferDetailFieldContext,
  t: Translate
) => ProviderTransferDetailRow[];

function moonpayBuilder(
  transfer: PaymentTransferSummary,
  context: TransferDetailFieldContext,
  t: Translate
): ProviderTransferDetailRow[] {
  const settlement = transfer.settlement;
  const receipt: ProviderTransferDetailRow[] = transfer.providerReference
    ? [
        {
          key: "DashboardPayments.transferDetails.receipt",
          label: t("DashboardPayments.transferDetails.receipt"),
          value: t("DashboardPayments.transferDetails.viewReceipt"),
          href: moonpayTrackerUrl(transfer.providerReference),
        },
      ]
    : [];
  const settlementRows =
    settlement !== undefined && settlement.provider === "moonpay"
      ? rowsFromSpecs(MOONPAY_FIELDS, settlement, context, t)
      : [];
  return [...receipt, ...settlementRows];
}

function coinbaseBuilder(
  transfer: PaymentTransferSummary,
  context: TransferDetailFieldContext,
  t: Translate
): ProviderTransferDetailRow[] {
  const settlement = transfer.settlement;
  return settlement !== undefined && settlement.provider === "coinbase"
    ? rowsFromSpecs(COINBASE_FIELDS, settlement, context, t)
    : [];
}

function lightsparkBuilder(
  transfer: PaymentTransferSummary,
  context: TransferDetailFieldContext,
  t: Translate
): ProviderTransferDetailRow[] {
  const settlement = transfer.settlement;
  return settlement !== undefined && settlement.provider === "lightspark"
    ? rowsFromSpecs(LIGHTSPARK_FIELDS, settlement, context, t)
    : [];
}

function bvnkBuilder(
  transfer: PaymentTransferSummary,
  context: TransferDetailFieldContext,
  t: Translate
): ProviderTransferDetailRow[] {
  const settlement = transfer.settlement;
  if (settlement === undefined || settlement.provider !== "bvnk") {
    return [];
  }
  const receipt: ProviderTransferDetailRow[] = [
    {
      key: "DashboardPayments.transferDetails.receipt",
      label: t("DashboardPayments.transferDetails.receipt"),
      value: t("DashboardPayments.transferDetails.viewReceipt"),
      href: bvnkPayoutReceiptUrl(settlement.payoutId, SDP_ENVIRONMENT_BY_CLUSTER[context.cluster]),
    },
  ];
  return [...receipt, ...rowsFromSpecs(BVNK_FIELDS, settlement, context, t)];
}

/**
 * Detail rows each provider contributes to the transfer modal, keyed by
 * provider and ramp direction. Providers absent here (or directions a
 * provider does not serve) contribute nothing.
 */
const PROVIDER_TRANSFER_DETAIL_FIELDS: Partial<
  Record<RampProviderId, Partial<Record<RampTransferDirection, ProviderRowBuilder>>>
> = {
  moonpay: { onramp: moonpayBuilder, offramp: moonpayBuilder },
  coinbase: { onramp: coinbaseBuilder },
  lightspark: { onramp: lightsparkBuilder, offramp: lightsparkBuilder },
  bvnk: { onramp: bvnkBuilder },
};

/**
 * Resolves the provider-specific detail rows for one transfer.
 *
 * @param transfer - The transfer shown in the detail modal.
 * @param context - The active cluster for link derivation.
 * @param t - Translator for row labels.
 * @returns The rows to render; empty when the provider/direction contributes none.
 */
export function providerTransferDetailRows(
  transfer: PaymentTransferSummary,
  context: TransferDetailFieldContext,
  t: Translate
): ProviderTransferDetailRow[] {
  if (!transfer.provider || (transfer.type !== "onramp" && transfer.type !== "offramp")) {
    return [];
  }
  const builder = PROVIDER_TRANSFER_DETAIL_FIELDS[transfer.provider]?.[transfer.type];
  if (builder === undefined) {
    return [];
  }
  return builder(transfer, context, t);
}
