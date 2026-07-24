export const CUSTODY_PROVIDERS = [
  "local",
  "fireblocks",
  "privy",
  "coinbase_cdp",
  "para",
  "turnkey",
  "dfns",
  "ibm_haven",
  "anchorage",
  "utila",
] as const;

export type CustodyProvider = (typeof CUSTODY_PROVIDERS)[number];
export type ManagedCustodyProvider = Exclude<CustodyProvider, "local">;

export const CUSTODY_PROVIDER_DISPLAY_STATUSES = [
  "available",
  "active",
  "pending",
  "request_access",
  "unavailable",
] as const;
export type CustodyProviderDisplayStatus = (typeof CUSTODY_PROVIDER_DISPLAY_STATUSES)[number];

export const FULL_SIGNING_CUSTODY_PROVIDERS = [
  "fireblocks",
  "privy",
  "coinbase_cdp",
  "para",
  "turnkey",
  "dfns",
  "ibm_haven",
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
  ibm_haven: {
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

export const CUSTODY_PROVIDER_USE_CASES = ["issuance", "transfers", "compliance"] as const;
export type CustodyProviderUseCase = (typeof CUSTODY_PROVIDER_USE_CASES)[number];

export const CUSTODY_PROVIDER_USE_CASE_LABEL_KEYS = {
  issuance: "DashboardCustody.issuance",
  transfers: "DashboardCustody.transfers",
  compliance: "DashboardCustody.compliance",
} as const satisfies Record<CustodyProviderUseCase, string>;

export const CUSTODY_PROVIDER_CATEGORIES = ["server", "institutional"] as const;
export type CustodyProviderCategory = (typeof CUSTODY_PROVIDER_CATEGORIES)[number];

export const CUSTODY_PROVIDER_CATEGORY_DETAILS = {
  server: {
    labelKey: "DashboardCustody.providerCategoryApi",
    descriptionKey: "DashboardCustody.providerCategoryApiDescription",
  },
  institutional: {
    labelKey: "DashboardCustody.providerCategoryInstitutional",
    descriptionKey: "DashboardCustody.providerCategoryInstitutionalDescription",
  },
} as const satisfies Record<CustodyProviderCategory, { labelKey: string; descriptionKey: string }>;

export interface CustodyProviderSetupFieldOption {
  value: string;
  labelKey: string;
}

interface CustodyProviderSetupFieldBase {
  key: string;
  labelKey: string;
  helpTextKey: string;
  required: boolean;
}

type CustodyProviderSetupFieldInput =
  | { kind: "text"; defaultValue?: string }
  | { kind: "password" }
  | {
      kind: "select";
      defaultValue: string;
      options: readonly CustodyProviderSetupFieldOption[];
    };

type CustodyProviderSetupFieldValueHandling =
  | { valueHandling: "plain" }
  | { valueHandling: "redacted_metadata"; redactionKind: "suffix" }
  | { valueHandling: "secret" };

export type CustodyProviderSetupField = CustodyProviderSetupFieldBase &
  CustodyProviderSetupFieldInput &
  CustodyProviderSetupFieldValueHandling;

export type CustodyProviderStoredCredentialSetup =
  | { mode: "self_service"; fields: readonly CustodyProviderSetupField[] }
  | { mode: "request_access"; requestAccessUrl: string }
  | { mode: "unavailable" };

interface CustodyProviderCatalogEntryShape {
  id: CustodyProvider;
  label: string;
  descriptionKey: string;
  category: CustodyProviderCategory;
  visible: boolean;
  technicalCapabilities: CustodyProviderCapabilities;
  useCases: readonly CustodyProviderUseCase[];
  storedCredentialSetup: CustodyProviderStoredCredentialSetup;
}

type CustodyProviderCatalogByIdShape = {
  [Provider in CustodyProvider]: CustodyProviderCatalogEntryShape & { id: Provider };
};

const DEFAULT_CUSTODY_PROVIDER_USE_CASES = CUSTODY_PROVIDER_USE_CASES;

export const CUSTODY_PROVIDER_CATALOG_BY_ID = {
  local: {
    id: "local",
    label: "Local Signer",
    descriptionKey: "DashboardCustody.providerLocalDescription",
    category: "server",
    visible: true,
    technicalCapabilities: CUSTODY_PROVIDER_CAPABILITIES.local,
    useCases: ["issuance", "transfers"],
    storedCredentialSetup: { mode: "unavailable" },
  },
  privy: {
    id: "privy",
    label: "Privy",
    descriptionKey: "DashboardCustody.providerPrivyDescription",
    category: "server",
    visible: true,
    technicalCapabilities: CUSTODY_PROVIDER_CAPABILITIES.privy,
    useCases: DEFAULT_CUSTODY_PROVIDER_USE_CASES,
    storedCredentialSetup: {
      mode: "self_service",
      fields: [
        {
          key: "credentialLabel",
          labelKey: "DashboardCustody.providerCredentialLabel",
          helpTextKey: "DashboardCustody.providerCredentialLabelDescription",
          kind: "text",
          required: true,
          defaultValue: "Privy credential",
          valueHandling: "plain",
        },
        {
          key: "scope",
          labelKey: "DashboardCustody.providerCredentialScope",
          helpTextKey: "DashboardCustody.providerCredentialScopeDescription",
          kind: "select",
          required: true,
          defaultValue: "organization",
          options: [
            {
              value: "organization",
              labelKey: "DashboardCustody.providerCredentialScopeOrganization",
            },
            {
              value: "project",
              labelKey: "DashboardCustody.providerCredentialScopeProject",
            },
          ],
          valueHandling: "plain",
        },
        {
          key: "appId",
          labelKey: "DashboardCustody.providerPrivyAppId",
          helpTextKey: "DashboardCustody.providerPrivyAppIdDescription",
          kind: "text",
          required: true,
          valueHandling: "redacted_metadata",
          redactionKind: "suffix",
        },
        {
          key: "appSecret",
          labelKey: "DashboardCustody.providerPrivyAppSecret",
          helpTextKey: "DashboardCustody.providerPrivyAppSecretDescription",
          kind: "password",
          required: true,
          valueHandling: "secret",
        },
        {
          key: "walletLabel",
          labelKey: "DashboardCustody.providerInitialWalletLabel",
          helpTextKey: "DashboardCustody.providerInitialWalletLabelDescription",
          kind: "text",
          required: false,
          valueHandling: "plain",
        },
      ],
    },
  },
  fireblocks: {
    id: "fireblocks",
    label: "Fireblocks",
    descriptionKey: "DashboardCustody.providerFireblocksDescription",
    category: "institutional",
    visible: true,
    technicalCapabilities: CUSTODY_PROVIDER_CAPABILITIES.fireblocks,
    useCases: DEFAULT_CUSTODY_PROVIDER_USE_CASES,
    storedCredentialSetup: {
      mode: "request_access",
      requestAccessUrl: "https://solanafoundation.typeform.com/to/wShiq9SN",
    },
  },
  coinbase_cdp: {
    id: "coinbase_cdp",
    label: "Coinbase CDP",
    descriptionKey: "DashboardCustody.providerCoinbaseCdpDescription",
    category: "server",
    visible: true,
    technicalCapabilities: CUSTODY_PROVIDER_CAPABILITIES.coinbase_cdp,
    useCases: DEFAULT_CUSTODY_PROVIDER_USE_CASES,
    storedCredentialSetup: { mode: "unavailable" },
  },
  para: {
    id: "para",
    label: "Para",
    descriptionKey: "DashboardCustody.providerParaDescription",
    category: "server",
    visible: true,
    technicalCapabilities: CUSTODY_PROVIDER_CAPABILITIES.para,
    useCases: DEFAULT_CUSTODY_PROVIDER_USE_CASES,
    storedCredentialSetup: { mode: "unavailable" },
  },
  turnkey: {
    id: "turnkey",
    label: "Turnkey",
    descriptionKey: "DashboardCustody.providerTurnkeyDescription",
    category: "server",
    visible: true,
    technicalCapabilities: CUSTODY_PROVIDER_CAPABILITIES.turnkey,
    useCases: DEFAULT_CUSTODY_PROVIDER_USE_CASES,
    storedCredentialSetup: { mode: "unavailable" },
  },
  dfns: {
    id: "dfns",
    label: "DFNS",
    descriptionKey: "DashboardCustody.providerDfnsDescription",
    category: "institutional",
    visible: true,
    technicalCapabilities: CUSTODY_PROVIDER_CAPABILITIES.dfns,
    useCases: DEFAULT_CUSTODY_PROVIDER_USE_CASES,
    storedCredentialSetup: { mode: "unavailable" },
  },
  ibm_haven: {
    id: "ibm_haven",
    label: "IBM Digital Asset Haven",
    descriptionKey: "DashboardCustody.providerIbmHavenDescription",
    category: "institutional",
    visible: true,
    technicalCapabilities: CUSTODY_PROVIDER_CAPABILITIES.ibm_haven,
    useCases: DEFAULT_CUSTODY_PROVIDER_USE_CASES,
    storedCredentialSetup: { mode: "unavailable" },
  },
  anchorage: {
    id: "anchorage",
    label: "Anchorage",
    descriptionKey: "DashboardCustody.providerAnchorageDescription",
    category: "institutional",
    visible: true,
    technicalCapabilities: CUSTODY_PROVIDER_CAPABILITIES.anchorage,
    useCases: ["transfers", "compliance"],
    storedCredentialSetup: { mode: "unavailable" },
  },
  utila: {
    id: "utila",
    label: "Utila",
    descriptionKey: "DashboardCustody.providerUtilaDescription",
    category: "institutional",
    visible: true,
    technicalCapabilities: CUSTODY_PROVIDER_CAPABILITIES.utila,
    useCases: DEFAULT_CUSTODY_PROVIDER_USE_CASES,
    storedCredentialSetup: { mode: "unavailable" },
  },
} as const satisfies CustodyProviderCatalogByIdShape;

export type CustodyProviderCatalogEntry = (typeof CUSTODY_PROVIDER_CATALOG_BY_ID)[CustodyProvider];

export const CUSTODY_PROVIDER_CATALOG: readonly CustodyProviderCatalogEntry[] = Object.values(
  CUSTODY_PROVIDER_CATALOG_BY_ID
);

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
  requestDelayMs?: number;
  walletId?: string;
}

export interface CoinbaseCdpCustodyOptions {
  provider: "coinbase_cdp";
  network?: SolanaCustodyNetwork;
  walletAddress?: string;
  accountPolicy?: string;
}

export interface ParaCustodyOptions {
  provider: "para";
  requestDelayMs?: number;
  walletId?: string;
}

export interface TurnkeyCustodyOptions {
  provider: "turnkey";
  requestDelayMs?: number;
  privateKeyId?: string;
}

export interface DfnsCustodyOptions {
  provider: "dfns";
  network?: DfnsCustodyNetwork;
  walletId?: string;
  signingKeyId?: string;
}

// IBM Digital Asset Haven is a white-label deployment of the Dfns WaaS API, so it
// reuses the Dfns request/signing surface with an IBM-hosted base URL.
export interface IbmHavenCustodyOptions {
  provider: "ibm_haven";
  network?: DfnsCustodyNetwork;
  walletId?: string;
  signingKeyId?: string;
}

export interface AnchorageCustodyOptions {
  provider: "anchorage";
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

export interface InitializeIbmHavenSigningRequest extends IbmHavenCustodyOptions {
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
  | InitializeIbmHavenSigningRequest
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
  | InitializeIbmHavenSigningRequest
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

export interface CustodyWalletMetadata extends CustodyWalletSummary {
  custodyConfigId: string;
  provider: CustodyProvider;
}

export interface CustodyWalletWithBalance extends CustodyWalletMetadata {
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

export interface CustodyWalletMetadataResponse {
  wallet: CustodyWalletMetadata;
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
