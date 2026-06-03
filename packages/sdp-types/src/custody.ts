export const CUSTODY_PROVIDERS = [
  "local",
  "fireblocks",
  "privy",
  "coinbase_cdp",
  "para",
  "turnkey",
  "dfns",
  "anchorage",
  "utila",
] as const;

export type CustodyProvider = (typeof CUSTODY_PROVIDERS)[number];
export type ManagedCustodyProvider = Exclude<CustodyProvider, "local">;
export const FULL_SIGNING_CUSTODY_PROVIDERS = [
  "fireblocks",
  "privy",
  "coinbase_cdp",
  "para",
  "turnkey",
  "dfns",
  "utila",
] as const;
export type FullSigningCustodyProvider = (typeof FULL_SIGNING_CUSTODY_PROVIDERS)[number];

export interface CustodyProviderCapabilities {
  supportsSigning: boolean;
  supportsAdditionalWalletCreation: boolean;
  supportsWalletDeletion: boolean;
}

export const CUSTODY_PROVIDER_CAPABILITIES: Record<CustodyProvider, CustodyProviderCapabilities> = {
  local: {
    supportsSigning: true,
    supportsAdditionalWalletCreation: false,
    supportsWalletDeletion: false,
  },
  fireblocks: {
    supportsSigning: true,
    supportsAdditionalWalletCreation: true,
    supportsWalletDeletion: false,
  },
  privy: {
    supportsSigning: true,
    supportsAdditionalWalletCreation: true,
    supportsWalletDeletion: false,
  },
  coinbase_cdp: {
    supportsSigning: true,
    supportsAdditionalWalletCreation: true,
    supportsWalletDeletion: false,
  },
  para: {
    supportsSigning: true,
    supportsAdditionalWalletCreation: true,
    supportsWalletDeletion: false,
  },
  turnkey: {
    supportsSigning: true,
    supportsAdditionalWalletCreation: true,
    supportsWalletDeletion: false,
  },
  dfns: {
    supportsSigning: true,
    supportsAdditionalWalletCreation: true,
    supportsWalletDeletion: false,
  },
  anchorage: {
    supportsSigning: false,
    supportsAdditionalWalletCreation: true,
    supportsWalletDeletion: true,
  },
  utila: {
    supportsSigning: true,
    supportsAdditionalWalletCreation: true,
    supportsWalletDeletion: false,
  },
};

export type SolanaCustodyNetwork = "solana" | "solana-devnet";
export type DfnsCustodyNetwork = "Solana" | "SolanaDevnet";
export type CustodyWalletPurpose =
  | "root"
  | "mint_authority"
  | "freeze_authority"
  | "fee_payer"
  | "transfer";
export type CustodyConfigStatus = "active" | "inactive";
export type CustodyWalletStatus = "active" | "inactive";

export interface FireblocksCustodyOptions {
  provider: "fireblocks";
}

export interface PrivyCustodyOptions {
  provider: "privy";
  apiBaseUrl?: string;
  requestDelayMs?: number;
  walletId?: string;
}

export interface CoinbaseCdpCustodyOptions {
  provider: "coinbase_cdp";
  apiBaseUrl?: string;
  network?: SolanaCustodyNetwork;
  walletAddress?: string;
  accountPolicy?: string;
}

export interface ParaCustodyOptions {
  provider: "para";
  apiBaseUrl?: string;
  requestDelayMs?: number;
  walletId?: string;
}

export interface TurnkeyCustodyOptions {
  provider: "turnkey";
  apiBaseUrl?: string;
  requestDelayMs?: number;
  privateKeyId?: string;
}

export interface DfnsCustodyOptions {
  provider: "dfns";
  apiBaseUrl?: string;
  network?: DfnsCustodyNetwork;
  walletId?: string;
  signingKeyId?: string;
}

export interface AnchorageCustodyOptions {
  provider: "anchorage";
  apiBaseUrl?: string;
  walletId?: string;
  network?: SolanaCustodyNetwork;
}

export interface UtilaCustodyOptions {
  provider: "utila";
}

export interface InitializeLocalSigningRequest {
  provider: "local";
  projectId?: string;
  walletLabel?: string;
}

export interface InitializeFireblocksSigningRequest extends FireblocksCustodyOptions {
  projectId?: string;
  walletLabel?: string;
}

export interface InitializePrivySigningRequest extends PrivyCustodyOptions {
  projectId?: string;
  walletLabel?: string;
}

export interface InitializeCoinbaseCdpSigningRequest extends CoinbaseCdpCustodyOptions {
  projectId?: string;
  walletLabel?: string;
}

export interface InitializeParaSigningRequest extends ParaCustodyOptions {
  projectId?: string;
  walletLabel?: string;
}

export interface InitializeTurnkeySigningRequest extends TurnkeyCustodyOptions {
  projectId?: string;
  walletLabel?: string;
}

export interface InitializeDfnsSigningRequest extends DfnsCustodyOptions {
  projectId?: string;
  walletLabel?: string;
}

export interface InitializeAnchorageSigningRequest extends AnchorageCustodyOptions {
  projectId?: string;
  walletLabel?: string;
}

export interface InitializeUtilaSigningRequest extends UtilaCustodyOptions {
  projectId?: string;
  walletLabel?: string;
}

export type InitializeSigningRequest =
  | InitializeLocalSigningRequest
  | InitializeFireblocksSigningRequest
  | InitializePrivySigningRequest
  | InitializeCoinbaseCdpSigningRequest
  | InitializeParaSigningRequest
  | InitializeTurnkeySigningRequest
  | InitializeDfnsSigningRequest
  | InitializeAnchorageSigningRequest
  | InitializeUtilaSigningRequest;

export interface SwitchFireblocksSigningRequest extends FireblocksCustodyOptions {
  projectId?: string;
}

export type SwitchSigningRequest =
  | InitializeLocalSigningRequest
  | SwitchFireblocksSigningRequest
  | InitializePrivySigningRequest
  | InitializeCoinbaseCdpSigningRequest
  | InitializeParaSigningRequest
  | InitializeTurnkeySigningRequest
  | InitializeDfnsSigningRequest
  | InitializeAnchorageSigningRequest
  | InitializeUtilaSigningRequest;

export interface CreateWalletRequest {
  projectId?: string;
  provider?: CustodyProvider;
  label?: string;
  purpose?: CustodyWalletPurpose;
  setDefault?: boolean;
}

export interface SetDefaultWalletRequest {
  projectId?: string;
  provider?: CustodyProvider;
  walletId: string;
}

export interface DeleteWalletRequest {
  projectId?: string;
  provider?: CustodyProvider;
  walletId: string;
}

export interface SignerCheckRequest {
  memo?: string;
  walletId?: string;
}

export interface CustodyConfigSummary {
  id: string;
  organizationId: string;
  projectId: string | null;
  provider: CustodyProvider;
  publicKey: string;
  defaultWalletId: string | null;
  status: CustodyConfigStatus;
  createdAt: string;
}

export interface CustodyWalletSummary {
  id: string;
  custodyConfigId?: string;
  provider?: CustodyProvider;
  isDefaultProvider?: boolean;
  walletId: string;
  publicKey: string;
  label: string | null;
  purpose: string | null;
  status: CustodyWalletStatus;
  createdAt: string;
  balances?: CustodyWalletTokenBalance[];
}

export interface CustodyWalletBalance {
  token: "SOL";
  mint: string;
  amount: string;
  uiAmount: string;
  decimals: 9;
  usdPrice?: number;
  usdValue?: number;
}

export interface CustodyWalletTokenBalance {
  token: string;
  mint: string;
  amount: string;
  uiAmount: string;
  decimals: number;
  usdPrice?: number;
  usdValue?: number;
}

export interface CustodyWalletWithBalance extends CustodyWalletSummary {
  custodyConfigId: string;
  provider: CustodyProvider;
  balance: CustodyWalletBalance;
}

export interface CustodyConfigWithDefault extends CustodyConfigSummary {
  isDefault: boolean;
}

export interface SwitchProviderOption {
  provider: CustodyProvider;
  hasReusableWallet: boolean;
  needsWalletLabel: boolean;
  isActive: boolean;
  isDefault: boolean;
}

export interface CustodyConfigResponse {
  config: CustodyConfigSummary;
}

export interface CustodyWalletResponse {
  wallet: CustodyWalletSummary;
}

export interface CustodyWalletsResponse {
  wallets: CustodyWalletSummary[];
}

export interface CustodyWalletAggregate {
  walletCount: number;
  balances: CustodyWalletTokenBalance[];
}

export interface CustodyWalletAggregateResponse {
  aggregate: CustodyWalletAggregate;
}

export interface CustodyWalletByIdResponse {
  wallet: CustodyWalletWithBalance;
}

export interface CustodyConfigsResponse {
  configs: CustodyConfigWithDefault[];
  defaultConfigId: string | null;
}

export interface SwitchProviderOptionsResponse {
  providers: SwitchProviderOption[];
}

export interface DeleteWalletResponse {
  walletId: string;
  deleted: true;
}

export interface InitializeSigningResponse {
  configId: string;
  publicKey: string;
  walletId: string;
}

export interface SignerCheckResponse {
  walletId: string;
  walletAddress: string;
  feePayer: string;
  memo: string;
  signature: string;
  slot: number;
  blockTime: string;
}
