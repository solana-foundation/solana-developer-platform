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

// Presentation-only layer for the create-asset wizard. It annotates the shared
// registry codes from `@sdp/types` (ASSET_TYPES / ASSET_TYPE_REGISTRY) with
// display fields the shared package intentionally omits — icon, short card
// label, one-line description, and ordering. It does NOT define codes or
// validation; every `category`/`type` here must exist in ASSET_TYPES (asserted
// below in dev).

export interface SubAssetTypePresentation {
  type: string;
  label: string;
  description: string;
  icon: LucideIcon;
}

export interface CategoryPresentation {
  category: AssetCategory;
  label: string;
  description: string;
  icon: LucideIcon;
  subTypes: SubAssetTypePresentation[];
}

export const ASSET_TAXONOMY: readonly CategoryPresentation[] = [
  {
    category: "stablecoin",
    label: "Stablecoin",
    description:
      "Assets designed to maintain a stable value, typically backed by fiat or other liquid assets.",
    icon: Landmark,
    subTypes: [
      {
        type: "fiat_backed",
        label: "Fiat-backed",
        description:
          "Backed 1:1 by fiat currency reserves held in regulated financial institutions.",
        icon: Banknote,
      },
      {
        type: "crypto_backed",
        label: "Crypto-backed",
        description: "Collateralized by crypto assets held in custody to maintain the peg.",
        icon: Bitcoin,
      },
    ],
  },
  {
    category: "tokenized_security",
    label: "Tokenized Securities",
    description: "Regulated financial instruments or digital representations of securities.",
    icon: ScrollText,
    subTypes: [
      {
        type: "equity",
        label: "Equity",
        description: "Tokenized shares or equity-like interests in a company.",
        icon: TrendingUp,
      },
      {
        type: "debt",
        label: "Debt / Bond",
        description: "Bonds, notes, or other debt instruments.",
        icon: Layers,
      },
      {
        type: "fund",
        label: "Fund / ETF",
        description: "Fund interests or exchange-traded fund shares.",
        icon: PieChart,
      },
    ],
  },
  {
    category: "generic",
    label: "Non-Security Digital Assets",
    description: "Other tokenized assets that don't fit the above categories.",
    icon: Boxes,
    subTypes: [
      {
        type: "commodity",
        label: "Commodities",
        description: "Claims on physical commodities or natural resources.",
        icon: Package,
      },
      {
        type: "real_estate",
        label: "Real Estate",
        description: "Tokenized real-estate interests or property.",
        icon: Building2,
      },
      {
        type: "collectible",
        label: "Collectibles",
        description: "Unique or limited collectible assets.",
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
export function getCategoryLabel(category: AssetCategory | null): string | null {
  if (!category) {
    return null;
  }
  return getCategoryPresentation(category)?.label ?? category;
}

export function getAssetTypeLabel(
  category: AssetCategory | null,
  type: string | null
): string | null {
  if (!category || !type) {
    return null;
  }
  return (
    getSubTypePresentation(category, type)?.label ??
    getAssetTypeRegistryEntry(category, type)?.label ??
    type
  );
}
