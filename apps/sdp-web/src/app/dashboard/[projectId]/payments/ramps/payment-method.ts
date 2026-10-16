import type { MessageKey, TranslationValues } from "@/i18n/messages";

/** How a payment moves: onchain from a wallet, or through a fiat ramp provider. */
export type PaymentMethod = "onchain" | "ramp";

type Translate = (key: MessageKey, values?: TranslationValues) => string;

/**
 * Resolves the visible label for a payments action method.
 *
 * @param t - Translator resolved from the i18n provider.
 * @param mode - Whether the action sends or receives funds.
 * @param method - The selected payment method.
 * @returns The localized payment method label.
 */
export function getPaymentMethodLabel(
  t: Translate,
  mode: "send" | "receive",
  method: PaymentMethod
): string {
  if (mode === "send") {
    return method === "onchain"
      ? t("DashboardPayments.paymentMethods.onchainTransfer")
      : t("DashboardPayments.paymentMethods.payWithFiat");
  }
  return method === "onchain"
    ? t("DashboardPayments.paymentMethods.onchainDeposit")
    : t("DashboardPayments.paymentMethods.depositWithFiat");
}
