import type { Counterparty, CounterpartyEntityType, RampProviderId } from "@sdp/types";
import { RAMP_PROVIDER_SUPPORT_DETAILS, type RampFiatCurrency } from "@sdp/types/generated/ramp";
import {
  getCryptoRailAssetLabel,
  type RampProviderDirectionSupport,
} from "@sdp/types/payment-rails";
import type { ProviderAvailabilityEntry } from "@sdp/types/provider-access";
import type { AppLocale } from "@/i18n/config";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import type { RampProviderAccess } from "@/lib/provider-availability";
import type { RampDirection, RampPair, RampProviderOption, SelectedRampPair } from "@/lib/ramps";

type Translate = (key: MessageKey, values?: TranslationValues) => string;

/** What reasons are written with: the catalog and the viewer's locale for joining lists. */
export interface ProviderReasonFormat {
  t: Translate;
  locale: AppLocale;
}

export interface ProviderExclusion {
  option: RampProviderOption;
  reasons: readonly string[];
}

const ENTITY_TYPE_LABEL_KEYS = {
  individual: "DashboardPayments.ramps.providerReasons.entityTypeIndividual",
  business: "DashboardPayments.ramps.providerReasons.entityTypeBusiness",
} as const satisfies Record<CounterpartyEntityType, MessageKey>;

export function getDirectionSupport(
  provider: RampProviderId,
  direction: RampDirection
): RampProviderDirectionSupport {
  return RAMP_PROVIDER_SUPPORT_DETAILS[provider][direction];
}

function providerAccessReason(access: ProviderAvailabilityEntry, t: Translate): string | null {
  if (!access.entitled) {
    return t("DashboardPayments.ramps.providerReasons.notOnPlan");
  }
  if (!access.configured) {
    return t("DashboardPayments.ramps.providerReasons.credentialsNotConfigured");
  }
  if (!access.enabled) {
    return t("DashboardPayments.ramps.providerReasons.disabledForOrganization");
  }
  return null;
}

function unsupportedPairReason(
  direction: RampDirection,
  selectedPair: SelectedRampPair,
  t: Translate
): string {
  const values = {
    fiatCurrency: selectedPair.fiatCurrency,
    asset: getCryptoRailAssetLabel(selectedPair.assetRail),
  };
  switch (direction) {
    case "onramp":
      return t("DashboardPayments.ramps.providerReasons.unsupportedOnrampPair", values);
    case "offramp":
      return t("DashboardPayments.ramps.providerReasons.unsupportedOfframpPair", values);
    default: {
      const exhaustive: never = direction;
      return exhaustive;
    }
  }
}

function formatEntityTypes(
  entityTypes: readonly CounterpartyEntityType[],
  { t, locale }: ProviderReasonFormat
): string {
  return new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(
    entityTypes.map((entityType) => t(ENTITY_TYPE_LABEL_KEYS[entityType]))
  );
}

/**
 * Off-ramp amount input is crypto-denominated while generated provider limits
 * are fiat-denominated, so limit exclusion reasons only apply to on-ramp.
 */
function amountLimitReasons(
  direction: RampDirection,
  support: RampProviderDirectionSupport,
  fiatCurrency: RampFiatCurrency,
  amount: string,
  t: Translate
): readonly string[] {
  if (direction === "offramp") {
    return [];
  }

  const parsedAmount = Number(amount.trim());
  if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
    return [];
  }

  const limits = support.currencies[fiatCurrency];
  if (limits === undefined) {
    return [];
  }

  const reasons: string[] = [];
  if (limits.min !== null && parsedAmount < Number(limits.min)) {
    reasons.push(
      t("DashboardPayments.ramps.providerReasons.minimumAmount", {
        amount: limits.min,
        currency: fiatCurrency,
      })
    );
  }
  if (limits.max !== null && parsedAmount > Number(limits.max)) {
    reasons.push(
      t("DashboardPayments.ramps.providerReasons.maximumAmount", {
        amount: limits.max,
        currency: fiatCurrency,
      })
    );
  }
  return reasons;
}

/**
 * Why a provider cannot take this ramp, or null when it can: its access, the pair, the
 * counterparty's kind and the amount's limits, each reason written from the catalog.
 */
export function buildProviderExclusion(args: {
  option: RampProviderOption;
  direction: RampDirection;
  rampProviderAccess: RampProviderAccess | null;
  selectedPairSupport: RampPair | null;
  selectedPair: SelectedRampPair;
  selectedCounterparty: Counterparty | null;
  amount: string;
  format: ProviderReasonFormat;
}): ProviderExclusion | null {
  const {
    option,
    direction,
    rampProviderAccess,
    selectedPairSupport,
    selectedPair,
    selectedCounterparty,
    amount,
    format,
  } = args;
  const { t } = format;
  const provider = option.id;
  const reasons: string[] = [];
  const support = getDirectionSupport(provider, direction);

  if (rampProviderAccess !== null) {
    const access = rampProviderAccess[provider];
    if (access === undefined) {
      reasons.push(t("DashboardPayments.ramps.providerReasons.availabilityNotReported"));
    } else {
      const reason = providerAccessReason(access, t);
      if (reason !== null) {
        reasons.push(reason);
      }
    }
  }

  if (selectedPairSupport === null || !selectedPairSupport.providers.includes(provider)) {
    reasons.push(unsupportedPairReason(direction, selectedPair, t));
  }

  if (selectedCounterparty !== null && support.entityTypes.length > 0) {
    if (!support.entityTypes.includes(selectedCounterparty.entityType)) {
      reasons.push(
        t("DashboardPayments.ramps.providerReasons.counterpartyTypesOnly", {
          entityTypes: formatEntityTypes(support.entityTypes, format),
        })
      );
    }
  }

  reasons.push(...amountLimitReasons(direction, support, selectedPair.fiatCurrency, amount, t));

  if (reasons.length === 0) {
    return null;
  }

  return { option, reasons };
}
