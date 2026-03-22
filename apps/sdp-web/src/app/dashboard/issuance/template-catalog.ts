export type IssuanceTemplateId = "stablecoin" | "tokenized-security" | "custom";

export interface IssuanceTemplateCatalogEntry {
  id: IssuanceTemplateId;
  name: string;
  description: string;
  helper: string;
  defaultDecimals: number;
}

export const issuanceTemplateCatalog: IssuanceTemplateCatalogEntry[] = [
  {
    id: "stablecoin",
    name: "Stablecoin",
    description: "USD-backed stablecoins with compliance controls.",
    helper: "Best for fiat-pegged assets with transfer controls and admin freeze support.",
    defaultDecimals: 6,
  },
  {
    id: "tokenized-security",
    name: "Tokenized Security",
    description: "Regulated assets with allowlist defaults.",
    helper: "Designed for regulated instruments where participant controls are mandatory.",
    defaultDecimals: 8,
  },
  {
    id: "custom",
    name: "Custom",
    description: "Fully customizable Token-2022 configuration.",
    helper: "Start from a blank profile and tune issuance settings for advanced requirements.",
    defaultDecimals: 9,
  },
];

export function getTemplateCatalogEntry(
  templateId: string | null | undefined
): IssuanceTemplateCatalogEntry | undefined {
  return issuanceTemplateCatalog.find((entry) => entry.id === templateId);
}
