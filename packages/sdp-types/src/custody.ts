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

/**
 * Every provider the catalog shows is built and runnable, so the status only
 * ever answers "what is my next step" — never "does this exist". The two
 * non-actionable states are deliberately distinct (HOO-772/775 and the
 * remove-signup-waitlist decision map): `request_access` is organization
 * access the SDP team grants, `not_configured` is environment availability —
 * the deployment does not hold that provider's credentials. Presenting one as
 * the other is how both prior vocabularies went wrong.
 */
export const CUSTODY_PROVIDER_DISPLAY_STATUSES = [
  "available",
  "active",
  "request_access",
  "not_configured",
] as const;
export type CustodyProviderDisplayStatus = (typeof CUSTODY_PROVIDER_DISPLAY_STATUSES)[number];

/**
 * Launch classification from the remove-signup-waitlist decision map: `general`
 * providers are open to every organization and gate only on deployment
 * credentials; `manual` providers additionally need the SDP team to grant the
 * organization access.
 */
export const CUSTODY_PROVIDER_AVAILABILITY_CLASSES = ["general", "manual"] as const;
export type CustodyProviderAvailabilityClass =
  (typeof CUSTODY_PROVIDER_AVAILABILITY_CLASSES)[number];

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

/**
 * How this provider's credentials come to exist: a self-service form, an
 * external request route, or none — the deployment supplies them via env.
 */
export type CustodyProviderStoredCredentialSetup =
  | { mode: "self_service"; fields: readonly CustodyProviderSetupField[] }
  | { mode: "request_access"; requestAccessUrl: string }
  | { mode: "none" };

interface CustodyProviderCatalogEntryShape {
  id: CustodyProvider;
  label: string;
  descriptionKey: string;
  category: CustodyProviderCategory;
  availability: CustodyProviderAvailabilityClass;
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
    availability: "general",
    visible: true,
    technicalCapabilities: CUSTODY_PROVIDER_CAPABILITIES.local,
    useCases: ["issuance", "transfers"],
    storedCredentialSetup: { mode: "none" },
  },
  privy: {
    id: "privy",
    label: "Privy",
    descriptionKey: "DashboardCustody.providerPrivyDescription",
    category: "server",
    availability: "general",
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
      ],
    },
  },
  fireblocks: {
    id: "fireblocks",
    label: "Fireblocks",
    descriptionKey: "DashboardCustody.providerFireblocksDescription",
    category: "institutional",
    availability: "manual",
    visible: true,
    technicalCapabilities: CUSTODY_PROVIDER_CAPABILITIES.fireblocks,
    useCases: DEFAULT_CUSTODY_PROVIDER_USE_CASES,
    // The one provider with an established external request route. The other
    // manual providers get a CTA when the request-access endpoint with
    // organization/provider attribution exists (decision-map.md #4) — not a
    // recycled link whose audience we have not confirmed.
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
    availability: "general",
    visible: true,
    technicalCapabilities: CUSTODY_PROVIDER_CAPABILITIES.coinbase_cdp,
    useCases: DEFAULT_CUSTODY_PROVIDER_USE_CASES,
    storedCredentialSetup: { mode: "none" },
  },
  para: {
    id: "para",
    label: "Para",
    descriptionKey: "DashboardCustody.providerParaDescription",
    category: "server",
    availability: "general",
    visible: true,
    technicalCapabilities: CUSTODY_PROVIDER_CAPABILITIES.para,
    useCases: DEFAULT_CUSTODY_PROVIDER_USE_CASES,
    storedCredentialSetup: { mode: "none" },
  },
  turnkey: {
    id: "turnkey",
    label: "Turnkey",
    descriptionKey: "DashboardCustody.providerTurnkeyDescription",
    category: "server",
    availability: "general",
    visible: true,
    technicalCapabilities: CUSTODY_PROVIDER_CAPABILITIES.turnkey,
    useCases: DEFAULT_CUSTODY_PROVIDER_USE_CASES,
    storedCredentialSetup: { mode: "none" },
  },
  dfns: {
    id: "dfns",
    label: "DFNS",
    descriptionKey: "DashboardCustody.providerDfnsDescription",
    category: "institutional",
    availability: "manual",
    visible: true,
    technicalCapabilities: CUSTODY_PROVIDER_CAPABILITIES.dfns,
    useCases: DEFAULT_CUSTODY_PROVIDER_USE_CASES,
    storedCredentialSetup: { mode: "none" },
  },
  ibm_haven: {
    id: "ibm_haven",
    label: "IBM Digital Asset Haven",
    descriptionKey: "DashboardCustody.providerIbmHavenDescription",
    category: "institutional",
    availability: "manual",
    visible: true,
    technicalCapabilities: CUSTODY_PROVIDER_CAPABILITIES.ibm_haven,
    useCases: DEFAULT_CUSTODY_PROVIDER_USE_CASES,
    storedCredentialSetup: { mode: "none" },
  },
  anchorage: {
    id: "anchorage",
    label: "Anchorage",
    descriptionKey: "DashboardCustody.providerAnchorageDescription",
    category: "institutional",
    availability: "manual",
    visible: true,
    technicalCapabilities: CUSTODY_PROVIDER_CAPABILITIES.anchorage,
    useCases: ["transfers", "compliance"],
    storedCredentialSetup: { mode: "none" },
  },
  utila: {
    id: "utila",
    label: "Utila",
    descriptionKey: "DashboardCustody.providerUtilaDescription",
    category: "institutional",
    availability: "manual",
    visible: true,
    technicalCapabilities: CUSTODY_PROVIDER_CAPABILITIES.utila,
    useCases: DEFAULT_CUSTODY_PROVIDER_USE_CASES,
    storedCredentialSetup: { mode: "none" },
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

export interface SwitchConnectionSigningRequest {
  connectionId: string;
  provider?: CustodyProvider;
}

export type SwitchSigningRequest =
  | SwitchConnectionSigningRequest
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
  connectionId?: string;
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

export type CustodyWalletOwner =
  | { custodyConfigId: string; custodyConnectionId?: never }
  | { custodyConfigId?: never; custodyConnectionId: string };

export type CustodyWalletSummary = CustodyWalletOwner & {
  id: string;
  provider?: CustodyProvider;
  isDefaultProvider?: boolean;
  isRuntimeExecutionAllowed: boolean;
  walletId: string;
  publicKey: string;
  label: string | null;
  purpose: string | null;
  status: CustodyWalletStatus;
  createdAt: string;
  balances?: CustodyWalletTokenBalance[];
};

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

export type CustodyWalletMetadata = CustodyWalletSummary & {
  provider: CustodyProvider;
};

export type CustodyWalletWithBalance = CustodyWalletMetadata & {
  balance: CustodyWalletBalance;
};

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

export type SwitchSigningResponse =
  | InitializeSigningResponse
  | {
      connectionId: string;
      publicKey: string;
      walletId: string;
    };

export interface SignerCheckResponse {
  walletId: string;
  walletAddress: string;
  feePayer: string;
  memo: string;
  signature: string;
  slot: number;
  blockTime: string;
}

/**
 * Lifecycle a custody Connection can be in. Counts of these are safe to publish
 * per provider; the Connections themselves are read from their own resource.
 */
export const CUSTODY_CONNECTION_LIFECYCLES = [
  "pending",
  "checking",
  "active",
  "failed",
  "deactivated",
] as const;
export type CustodyConnectionLifecycle = (typeof CUSTODY_CONNECTION_LIFECYCLES)[number];

/** Outcome of a single connection install check. */
export const CUSTODY_CONNECTION_CHECK_STATUSES = [
  "running",
  "success",
  "failed",
  "retry_unknown",
] as const;
export type CustodyConnectionCheckStatus = (typeof CUSTODY_CONNECTION_CHECK_STATUSES)[number];

/** Why a connection install check concluded unsuccessfully. */
export const CUSTODY_CONNECTION_FAILURE_CODES = [
  "invalid_credentials",
  "provider_response_unknown",
  "provider_account_already_connected",
  "wallet_conflict",
] as const;
export type CustodyConnectionFailureCode = (typeof CUSTODY_CONNECTION_FAILURE_CODES)[number];

/** Lifecycle of the stored provider credential backing a connection. */
export const PROVIDER_CREDENTIAL_STATUSES = [
  "pending",
  "active",
  "failed_validation",
  "retired",
  "deactivated",
] as const;
export type ProviderCredentialStatus = (typeof PROVIDER_CREDENTIAL_STATUSES)[number];

/**
 * Which record actually backs signing for a provider in the current scope.
 *
 * `none` covers the case that matters most for setup: a provider the deployment
 * has environment credentials for is *available to install*, not installed. Only
 * an explicit initialize produces a Config, and only a checked credential
 * produces a Connection.
 */
export type CustodyEffectiveTargetType = "none" | "config" | "connection";

export interface CustodyProviderSetupStatus {
  provider: CustodyProvider;
  /** An active `custody_configs` row exists in this scope — the legacy path. */
  hasLegacyConfig: boolean;
  effectiveTargetType: CustodyEffectiveTargetType;
  /** Bounded per provider: counts only, never a nested Connection inventory. */
  connectionCounts: Record<CustodyConnectionLifecycle, number>;
}

export interface CustodySetupStatusResponse {
  providers: CustodyProviderSetupStatus[];
}
