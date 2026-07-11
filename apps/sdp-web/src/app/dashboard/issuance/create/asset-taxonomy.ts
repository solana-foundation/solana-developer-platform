import {
  ASSET_TYPES,
  type AssetCategory,
  getAssetTypeRegistryEntry,
  isAssetTypeSupported,
} from "@sdp/types";
import {
  Banknote,
  Bitcoin,
  Boxes,
  Building2,
  Gem,
  Landmark,
  Layers,
  type LucideIcon,
  Package,
  PieChart,
  ScrollText,
  TrendingUp,
} from "lucide-react";
import type { MessageKey, TranslationValues } from "@/i18n/messages";

type Translate = (key: MessageKey, values?: TranslationValues) => string;

// Presentation-only layer for the create-asset wizard. It annotates the shared
// registry codes from `@sdp/types` (ASSET_TYPES / ASSET_TYPE_REGISTRY) with
// display fields the shared package intentionally omits — icon, short card
// label, one-line description, and ordering. It does NOT define codes or
// validation; every `category`/`type` here must exist in ASSET_TYPES (asserted
// below in dev).

export interface SubAssetTypePresentation {
  type: string;
  labelKey: MessageKey;
  descriptionKey: MessageKey;
  icon: LucideIcon;
}

export interface CategoryPresentation {
  category: AssetCategory;
  labelKey: MessageKey;
  descriptionKey: MessageKey;
  icon: LucideIcon;
  subTypes: SubAssetTypePresentation[];
}

export const ASSET_TAXONOMY: readonly CategoryPresentation[] = [
  {
    category: "stablecoin",
    labelKey: "DashboardIssuance.taxonomy.stablecoin",
    descriptionKey: "DashboardIssuance.taxonomy.stablecoinDescription",
    icon: Landmark,
    subTypes: [
      {
        type: "fiat_backed",
        labelKey: "DashboardIssuance.taxonomy.fiatBacked",
        descriptionKey: "DashboardIssuance.taxonomy.fiatBackedDescription",
        icon: Banknote,
      },
      {
        type: "crypto_backed",
        labelKey: "DashboardIssuance.taxonomy.cryptoBacked",
        descriptionKey: "DashboardIssuance.taxonomy.cryptoBackedDescription",
        icon: Bitcoin,
      },
    ],
  },
  {
    category: "tokenized_security",
    labelKey: "DashboardIssuance.taxonomy.tokenizedSecurity",
    descriptionKey: "DashboardIssuance.taxonomy.tokenizedSecurityDescription",
    icon: ScrollText,
    subTypes: [
      {
        type: "equity",
        labelKey: "DashboardIssuance.taxonomy.equity",
        descriptionKey: "DashboardIssuance.taxonomy.equityDescription",
        icon: TrendingUp,
      },
      {
        type: "debt",
        labelKey: "DashboardIssuance.taxonomy.debt",
        descriptionKey: "DashboardIssuance.taxonomy.debtDescription",
        icon: Layers,
      },
      {
        type: "fund",
        labelKey: "DashboardIssuance.taxonomy.fund",
        descriptionKey: "DashboardIssuance.taxonomy.fundDescription",
        icon: PieChart,
      },
    ],
  },
  {
    category: "generic",
    labelKey: "DashboardIssuance.taxonomy.generic",
    descriptionKey: "DashboardIssuance.taxonomy.genericDescription",
    icon: Boxes,
    subTypes: [
      {
        type: "commodity",
        labelKey: "DashboardIssuance.taxonomy.commodities",
        descriptionKey: "DashboardIssuance.taxonomy.commoditiesDescription",
        icon: Package,
      },
      {
        type: "real_estate",
        labelKey: "DashboardIssuance.taxonomy.realEstate",
        descriptionKey: "DashboardIssuance.taxonomy.realEstateDescription",
        icon: Building2,
      },
      {
        type: "collectible",
        labelKey: "DashboardIssuance.taxonomy.collectibles",
        descriptionKey: "DashboardIssuance.taxonomy.collectiblesDescription",
        icon: Gem,
      },
    ],
  },
];

// Fail fast in development if the presentation drifts from the shared registry —
// every presented (category, type) must be a supported pair, or a user could
// pick a card the API will reject.
if (process.env.NODE_ENV !== "production") {
  for (const category of ASSET_TAXONOMY) {
    for (const subType of category.subTypes) {
      if (!isAssetTypeSupported(category.category, subType.type)) {
        throw new Error(
          `asset-taxonomy: (${category.category}, ${subType.type}) is not in ASSET_TYPES. ` +
            `Available: ${ASSET_TYPES[category.category].join(", ")}`
        );
      }
    }
  }
}

export function getCategoryPresentation(
  category: AssetCategory | null
): CategoryPresentation | undefined {
  if (!category) {
    return undefined;
  }
  return ASSET_TAXONOMY.find((entry) => entry.category === category);
}

export function getSubTypePresentation(
  category: AssetCategory | null,
  type: string | null
): SubAssetTypePresentation | undefined {
  if (!category || !type) {
    return undefined;
  }
  return getCategoryPresentation(category)?.subTypes.find((entry) => entry.type === type);
}

// Friendly label for the summary rail / review. Prefers the short card label,
// falls back to the shared registry's canonical label, then the raw code.
export function getCategoryLabelKey(category: AssetCategory | null): MessageKey | null {
  if (!category) {
    return null;
  }
  return getCategoryPresentation(category)?.labelKey ?? null;
}

function getAssetTypeLabelKey(
  category: AssetCategory | null,
  type: string | null
): MessageKey | null {
  if (!category || !type) {
    return null;
  }
  return getSubTypePresentation(category, type)?.labelKey ?? null;
}

export function getAssetTypeLabel(
  category: AssetCategory | null,
  type: string | null,
  t: Translate
): string | null {
  if (!category || !type) {
    return null;
  }
  const labelKey = getAssetTypeLabelKey(category, type);
  return labelKey ? t(labelKey) : (getAssetTypeRegistryEntry(category, type)?.label ?? type);
}
