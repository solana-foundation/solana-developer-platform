import { BadgeDollarSign, CircleHelp, ShieldCheck } from "lucide-react";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import {
  type AccessControlMode,
  getDefaultAccessControlMode as getDefaultModeForTemplate,
  supportsBlocklistMode,
} from "./access-control.utils";
import type { CreateIssuanceTokenResult } from "./actions";
import type {
  TemplateCardDescriptor,
  TemplateSelection,
  TokenDraft,
} from "./create-token-modal.types";

export function getTemplateCards(t: Translate): Array<
  TemplateCardDescriptor & {
    icon: typeof BadgeDollarSign;
  }
> {
  return [
    {
      id: "stablecoin",
      name: t("DashboardIssuance.create.stablecoinTemplateName"),
      description: t("DashboardIssuance.create.stablecoinTemplateDescription"),
      icon: BadgeDollarSign,
      iconClassName: "bg-[#dee6ff] text-[#375dff]",
      enabled: true,
      template: "stablecoin",
    },
    {
      id: "tokenized-security",
      name: t("DashboardIssuance.create.tokenizedSecurityTemplateName"),
      description: t("DashboardIssuance.create.tokenizedSecurityTemplateDescription"),
      icon: ShieldCheck,
      iconClassName: "bg-[#d8f7e4] text-[#0f9b58]",
      enabled: true,
      template: "tokenized-security",
    },
    {
      id: "custom",
      name: t("DashboardIssuance.create.customTemplateName"),
      description: t("DashboardIssuance.create.customTemplateDescription"),
      icon: CircleHelp,
      iconClassName: "bg-[#ebe5ff] text-[#6436ff]",
      enabled: true,
      template: "custom",
    },
  ];
}

export const INITIAL_CREATE_ISSUANCE_TOKEN_RESULT: CreateIssuanceTokenResult = {
  state: "idle",
  message: null,
  tokenId: null,
  tokenName: null,
};

export function createInitialDraft(): TokenDraft {
  return {
    template: null,
    uri: "",
    name: "",
    symbol: "",
    signingWalletId: "",
    decimals: "",
    accessControlMode: "disabled",
  };
}

export function getTemplateTitle(template: TemplateSelection, t: Translate): string {
  switch (template) {
    case "stablecoin":
      return t("DashboardIssuance.create.createStablecoinDraft");
    case "custom":
      return t("DashboardIssuance.create.createCustomTokenDraft");
    case "tokenized-security":
      return t("DashboardIssuance.create.createTokenizedSecurityDraft");
    default:
      return t("DashboardIssuance.create.createTokenDraft");
  }
}

export function getCreateButtonLabel(template: TemplateSelection, t: Translate): string {
  return getTemplateTitle(template, t);
}

export function getTemplateDefaultDecimals(template: TemplateSelection): TokenDraft["decimals"] {
  switch (template) {
    case "stablecoin":
      return "6";
    case "custom":
      return "9";
    case "tokenized-security":
      return "8";
    default:
      return "6";
  }
}

export function getDefaultAccessControlMode(template: TemplateSelection): AccessControlMode {
  return getDefaultModeForTemplate(template);
}

export function isAccessControlModeAvailable(
  template: TemplateSelection,
  mode: AccessControlMode
): boolean {
  if (mode === "allowlist") {
    return true;
  }

  if (mode === "blocklist") {
    return supportsBlocklistMode(template);
  }

  return template === "custom";
}

type Translate = (key: MessageKey, values?: TranslationValues) => string;

export function getAccessControlOptions(
  template: TemplateSelection,
  t: Translate
): Array<{
  mode: AccessControlMode;
  title: string;
  description: string;
  note: string;
}> {
  if (template === "stablecoin") {
    return [
      {
        mode: "blocklist",
        title: t("DashboardIssuance.create.denylist"),
        description: t("DashboardIssuance.create.denylistDescription"),
        note: t("DashboardIssuance.create.stablecoinDenylistNote"),
      },
      {
        mode: "allowlist",
        title: t("DashboardIssuance.create.allowlist"),
        description: t("DashboardIssuance.create.allowlistDescription"),
        note: t("DashboardIssuance.create.stablecoinAllowlistNote"),
      },
    ];
  }

  if (template === "tokenized-security") {
    return [
      {
        mode: "allowlist",
        title: t("DashboardIssuance.create.allowlist"),
        description: t("DashboardIssuance.create.allowlistDescription"),
        note: t("DashboardIssuance.create.securityAllowlistNote"),
      },
      {
        mode: "blocklist",
        title: t("DashboardIssuance.create.denylist"),
        description: t("DashboardIssuance.create.denylistDescription"),
        note: t("DashboardIssuance.create.securityDenylistNote"),
      },
    ];
  }

  return [
    {
      mode: "disabled",
      title: t("DashboardIssuance.create.disabled"),
      description: t("DashboardIssuance.create.disabledDescription"),
      note: t("DashboardIssuance.create.customDisabledNote"),
    },
    {
      mode: "allowlist",
      title: t("DashboardIssuance.create.allowlist"),
      description: t("DashboardIssuance.create.allowlistDescription"),
      note: t("DashboardIssuance.create.customAllowlistNote"),
    },
  ];
}

export function toRequiresAllowlist(mode: AccessControlMode): boolean {
  return mode === "allowlist";
}

export function isValidMetadataUri(value: string): boolean {
  const trimmed = value.trim();
  // Optional (HOO-466): an empty URI is valid — SDP hosts the metadata JSON.
  if (!trimmed) {
    return true;
  }

  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function normalizeSymbol(symbol: string): string {
  return symbol.replace(/[^A-Za-z0-9.]/g, "").slice(0, 10);
}

export function isValidTokenSymbol(symbol: string): boolean {
  return /^[A-Za-z0-9.]{1,10}$/.test(symbol);
}

export function isValidTokenDecimals(value: string): boolean {
  if (!/^\d+$/.test(value)) {
    return false;
  }

  const parsed = Number.parseInt(value, 10);
  return parsed >= 0 && parsed <= 18;
}

export function getDecimalsHelperText(template: TemplateSelection, t: Translate): string {
  switch (template) {
    case "stablecoin":
      return t("DashboardIssuance.create.stablecoinDecimalsHelper");
    case "custom":
      return t("DashboardIssuance.create.customDecimalsHelper");
    case "tokenized-security":
      return t("DashboardIssuance.create.tokenizedSecurityDecimalsHelper");
    default:
      return t("DashboardIssuance.create.decimalsHelper");
  }
}
