export type IssuanceTemplateId = "stablecoin" | "tokenized-security" | "custom";

export interface IssuanceTemplateCatalogEntry {
  id: IssuanceTemplateId;
  nameKey: "stablecoinName" | "tokenizedSecurityName" | "customName";
  descriptionKey: "stablecoinDescription" | "tokenizedSecurityDescription" | "customDescription";
  helperKey: "stablecoinHelper" | "tokenizedSecurityHelper" | "customHelper";
  defaultDecimals: number;
}

export const issuanceTemplateCatalog: IssuanceTemplateCatalogEntry[] = [
  {
    id: "stablecoin",
    nameKey: "stablecoinName",
    descriptionKey: "stablecoinDescription",
    helperKey: "stablecoinHelper",
    defaultDecimals: 6,
  },
  {
    id: "tokenized-security",
    nameKey: "tokenizedSecurityName",
    descriptionKey: "tokenizedSecurityDescription",
    helperKey: "tokenizedSecurityHelper",
    defaultDecimals: 8,
  },
  {
    id: "custom",
    nameKey: "customName",
    descriptionKey: "customDescription",
    helperKey: "customHelper",
    defaultDecimals: 9,
  },
];

export function getTemplateCatalogEntry(
  templateId: string | null | undefined
): IssuanceTemplateCatalogEntry | undefined {
  return issuanceTemplateCatalog.find((entry) => entry.id === templateId);
}
