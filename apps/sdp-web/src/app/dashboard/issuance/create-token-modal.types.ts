export type TemplateSelection = "stablecoin" | "custom" | "tokenized-security";
export type CreationStep = "identity" | "features";
export type AccessControlMode = "allowlist" | "blocklist";

export type FlowState =
  | {
      kind: "templateSelection";
    }
  | {
      kind: "creation";
      template: TemplateSelection;
      step: CreationStep;
    };

export interface TokenDraft {
  template: TemplateSelection | null;
  uri: string;
  name: string;
  symbol: string;
  signingWalletId: string;
  decimals: "" | "0" | "6" | "8" | "9";
  accessControlMode: AccessControlMode;
}

export interface TemplateCardDescriptor {
  id: string;
  name: string;
  description: string;
  iconClassName: string;
  enabled: boolean;
  template?: TemplateSelection;
}

export interface IdentityValidation {
  uriValid: boolean;
  nameValid: boolean;
  symbolValid: boolean;
  decimalsValid: boolean;
  isValid: boolean;
}
