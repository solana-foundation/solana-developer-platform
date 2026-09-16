import type { RampFiatCurrency } from "@sdp/types/generated/ramp";
import { fiatCurrencyDisplayName, fiatCurrencyFlagEmoji } from "@sdp/types/payment-rails";
import type { ComboboxOption } from "@/components/ui/combobox";

/** Combobox options for fiat currencies: flag + ISO code as the label, CLDR name as the description. */
export function fiatCurrencyOptions(codes: readonly RampFiatCurrency[]): ComboboxOption[] {
  return codes.map((code) => {
    const flag = fiatCurrencyFlagEmoji(code);
    return {
      value: code,
      label: flag === null ? code : `${flag} ${code}`,
      description: fiatCurrencyDisplayName(code),
    };
  });
}
