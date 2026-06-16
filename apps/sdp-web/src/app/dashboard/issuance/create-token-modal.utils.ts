import { BadgeDollarSign, CircleHelp, ShieldCheck } from "lucide-react";
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

export const templateCards: Array<
  TemplateCardDescriptor & {
    icon: typeof BadgeDollarSign;
  }
> = [
  {
    id: "stablecoin",
    name: "Stablecoin",
    description: "Create a regulatory-compliant stablecoin with transfer restrictions.",
    icon: BadgeDollarSign,
    iconClassName: "bg-[#dee6ff] text-[#375dff]",
    enabled: true,
    template: "stablecoin",
  },
  {
    id: "tokenized-security",
    name: "Tokenized Security",
    description: "Create a compliant security token with scaled UI amounts and core controls.",
    icon: ShieldCheck,
    iconClassName: "bg-[#d8f7e4] text-[#0f9b58]",
    enabled: true,
    template: "tokenized-security",
  },
  {
    id: "custom",
    name: "Custom Token",
    description: "Build your own token with full control over extensions and parameters.",
    icon: CircleHelp,
    iconClassName: "bg-[#ebe5ff] text-[#6436ff]",
    enabled: true,
    template: "custom",
  },
];

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

export function getTemplateTitle(template: TemplateSelection): string {
  switch (template) {
    case "stablecoin":
      return "Create Stablecoin Draft";
    case "custom":
      return "Create Custom Token Draft";
    case "tokenized-security":
      return "Create Tokenized Security Draft";
    default:
      return "Create Token Draft";
  }
}

export function getCreateButtonLabel(template: TemplateSelection): string {
  switch (template) {
    case "stablecoin":
      return "Create Stablecoin Draft";
    case "custom":
      return "Create Custom Token Draft";
    case "tokenized-security":
      return "Create Tokenized Security Draft";
    default:
      return "Create Token Draft";
  }
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

export function getAccessControlOptions(template: TemplateSelection): Array<{
  mode: AccessControlMode;
  title: string;
  description: string;
  note: string;
}> {
  if (template === "stablecoin") {
    return [
      {
        mode: "blocklist",
        title: "Denylist",
        description: "Listed destinations are blocked before they can receive controlled actions.",
        note: "Recommended default for stablecoins.",
      },
      {
        mode: "allowlist",
        title: "Allowlist",
        description: "Only approved destinations can receive controlled token actions.",
        note: "Use when transfers must stay inside a known set of wallets.",
      },
    ];
  }

  if (template === "tokenized-security") {
    return [
      {
        mode: "allowlist",
        title: "Allowlist",
        description: "Only approved destinations can receive controlled token actions.",
        note: "Default for tokenized securities.",
      },
      {
        mode: "blocklist",
        title: "Denylist",
        description: "Listed destinations are blocked before they can receive controlled actions.",
        note: "Use when the token should remain open except for blocked wallets.",
      },
    ];
  }

  return [
    {
      mode: "disabled",
      title: "Disabled",
      description: "This token will not use a transfer control list.",
      note: "Best for unrestricted custom tokens.",
    },
    {
      mode: "allowlist",
      title: "Allowlist",
      description: "Only approved destinations can receive controlled token actions.",
      note: "Enable this when the token needs restricted transfer access.",
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

export function getDecimalsHelperText(template: TemplateSelection): string {
  switch (template) {
    case "stablecoin":
      return "Stablecoin defaults to 6 decimals, but you can choose any value from 0 to 18.";
    case "custom":
      return "Custom tokens default to 9 decimals. Choose any value from 0 to 18.";
    case "tokenized-security":
      return "Tokenized Security defaults to 8 decimals, but you can choose any value from 0 to 18.";
    default:
      return "Choose any value from 0 to 18.";
  }
}
