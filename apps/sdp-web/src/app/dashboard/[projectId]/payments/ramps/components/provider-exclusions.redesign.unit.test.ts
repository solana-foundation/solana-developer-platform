import type { Counterparty } from "@sdp/types";
import { describe, expect, it } from "vitest";
import { getMessages, type MessageKey, type TranslationValues, translate } from "@/i18n/messages";
import type { RampPair, SelectedRampPair } from "@/lib/ramps";
import { buildProviderExclusion, type ProviderReasonFormat } from "./provider-exclusions.redesign";

const t = (key: MessageKey, values?: TranslationValues) =>
  translate(getMessages("en"), key, values);
const english: ProviderReasonFormat = { t, locale: "en" };

const moonpay = { id: "moonpay", title: "MoonPay" } as const;
const usdToUsdc: SelectedRampPair = { fiatCurrency: "USD", assetRail: "usdc.solana" };
const supportedPair: RampPair = { ...usdToUsdc, providers: ["moonpay"] };
const business = { entityType: "business" } as Counterparty;

function reasons(
  overrides: Partial<Parameters<typeof buildProviderExclusion>[0]> = {}
): readonly string[] {
  return (
    buildProviderExclusion({
      option: moonpay,
      direction: "onramp",
      rampProviderAccess: null,
      selectedPairSupport: supportedPair,
      selectedPair: usdToUsdc,
      selectedCounterparty: null,
      amount: "",
      format: english,
      ...overrides,
    })?.reasons ?? []
  );
}

describe("buildProviderExclusion", () => {
  it("keeps a provider that can take the ramp", () => {
    expect(reasons()).toEqual([]);
  });

  it("words access reasons from the catalog", () => {
    expect(
      reasons({
        rampProviderAccess: { moonpay: { entitled: false, configured: true, enabled: true } },
      })
    ).toEqual(["Not available on your plan"]);
    expect(
      reasons({
        rampProviderAccess: { moonpay: { entitled: true, configured: false, enabled: true } },
      })
    ).toEqual(["Provider credentials are not configured for this environment"]);
    expect(
      reasons({
        rampProviderAccess: { moonpay: { entitled: true, configured: true, enabled: false } },
      })
    ).toEqual(["Disabled for this organization"]);
    expect(reasons({ rampProviderAccess: {} })).toEqual([
      "Availability is not reported for this environment",
    ]);
  });

  it("words an unsupported pair in the ramp's direction", () => {
    expect(reasons({ selectedPairSupport: null })).toEqual(["Does not support USD → USDC"]);
    expect(reasons({ direction: "offramp", selectedPairSupport: null })).toEqual([
      "Does not support USDC → USD",
    ]);
  });

  it("words the counterparty kinds and on-ramp limits", () => {
    expect(reasons({ selectedCounterparty: business })).toEqual([
      "Supports individual counterparties only",
    ]);
    expect(reasons({ amount: "5" })).toEqual(["Minimum is 20 USD"]);
    expect(reasons({ amount: "50000" })).toEqual(["Maximum is 30000 USD"]);
  });

  it("joins counterparty kinds with the viewer's locale", () => {
    // A subclass keeps the real formatter while recording the locale it was built with.
    const RealListFormat = Intl.ListFormat;
    const builtWith: unknown[] = [];
    class RecordingListFormat extends RealListFormat {
      constructor(locales?: Intl.LocalesArgument, options?: Intl.ListFormatOptions) {
        super(locales, options);
        builtWith.push(locales);
      }
    }
    const setListFormat = (value: typeof Intl.ListFormat) =>
      Object.defineProperty(Intl, "ListFormat", { value, configurable: true, writable: true });
    setListFormat(RecordingListFormat);
    try {
      reasons({ selectedCounterparty: business, format: { t, locale: "fr" } });
    } finally {
      setListFormat(RealListFormat);
    }
    expect(builtWith).toEqual(["fr"]);
  });
});
