import { BadgeDollarSign, CircleHelp, Gamepad2, ShieldCheck } from "lucide-react";
import type { CreateIssuanceTokenResult } from "./actions";
import type {
  AccessControlMode,
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
    id: "arcade",
    name: "Arcade Token",
    description: "Deploy a gaming or utility token with custom extensions and features.",
    icon: Gamepad2,
    iconClassName: "bg-[#f7ead8] text-[#ff6b00]",
    enabled: true,
    template: "arcade",
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
    accessControlMode: "blocklist",
  };
}

export function getTemplateTitle(template: TemplateSelection): string {
  switch (template) {
    case "stablecoin":
      return "Create a Stablecoin";
    case "custom":
      return "Create Custom Token";
    case "tokenized-security":
      return "Create Tokenized Security";
    case "arcade":
      return "Create Arcade Token";
    default:
      return "Create Token";
  }
}

export function getCreateButtonLabel(template: TemplateSelection): string {
  switch (template) {
    case "stablecoin":
      return "Create Stablecoin";
    case "custom":
      return "Create Custom Token";
    case "tokenized-security":
      return "Create Tokenized Security";
    case "arcade":
      return "Create Arcade Token";
    default:
      return "Create Token";
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
    case "arcade":
      return "0";
    default:
      return "6";
  }
}

export function getTemplateDecimalOptions(
  template: TemplateSelection
): ReadonlyArray<TokenDraft["decimals"]> {
  switch (template) {
    case "stablecoin":
    case "custom":
      return ["6", "9"];
    case "tokenized-security":
      return ["8"];
    case "arcade":
      return ["0", "6"];
    default:
      return ["6", "9"];
  }
}

export function getDefaultAccessControlMode(template: TemplateSelection): AccessControlMode {
  return template === "tokenized-security" ? "allowlist" : "blocklist";
}

export function getAccessControlAvailability(
  template: TemplateSelection,
  mode: AccessControlMode
): {
  available: boolean;
  note: string;
} {
  if (template === "tokenized-security") {
    if (mode === "allowlist") {
      return {
        available: true,
        note: "Required for this template.",
      };
    }
    return {
      available: false,
      note: "This template cannot be created without an allowlist.",
    };
  }

  return {
    available: true,
    note:
      mode === "allowlist"
        ? "Require approved destinations before minting or controlled transfers."
        : "Create the token without an allowlist.",
  };
}

export function toRequiresAllowlist(template: TemplateSelection, mode: AccessControlMode): boolean {
  if (template === "tokenized-security") {
    return true;
  }
  return mode === "allowlist";
}

export function isValidMetadataUri(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }

  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function normalizeSymbol(symbol: string): string {
  return symbol
    .toUpperCase()
    .replace(/[^A-Z0-9.]/g, "")
    .slice(0, 10);
}
