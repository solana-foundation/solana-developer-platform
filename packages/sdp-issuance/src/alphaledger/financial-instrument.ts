import type { AlphaLedgerService } from "./service";
import type {
  AlAccountLookup,
  AlId,
  AlItemsQuery,
  AlNewAlId,
  AlOffchainEntityType,
  AlOffchainFile,
  AlOffchainReferences,
  AlSvmCluster,
  AlSvmEntityResult,
  AlSvmTransactionResult,
  AlSvmValueResult,
  AlTenancyConfig,
  AlTokenVersion,
} from "./types";

interface AlCreateFinancialInstrumentOffchainReferencesBase {
  code: string;
  type: AlOffchainEntityType;
  name?: string;
}

/**
 * Offchain references for the new mint account. Exactly one of `alId` (an
 * identifier AlphaLedger already assigned) or `newAlId` (have AlphaLedger
 * generate one from the instrument type) must be supplied.
 */
export type AlCreateFinancialInstrumentOffchainReferences =
  | (AlCreateFinancialInstrumentOffchainReferencesBase & { alId: AlId; newAlId?: never })
  | (AlCreateFinancialInstrumentOffchainReferencesBase & { newAlId: AlNewAlId; alId?: never });

export interface AlCreateFinancialInstrumentPrivateKeyDetails {
  location: ("DATABASE" | "SECRETS" | "DKG")[];
}

export interface AlCreateFinancialInstrumentMintAccount {
  managed: boolean;
  alreadyOnchain?: boolean;
  onchainId?: string;
  offchainReferences: AlCreateFinancialInstrumentOffchainReferences;
  privateKeyDetails?: AlCreateFinancialInstrumentPrivateKeyDetails;
  tokenVersion?: AlTokenVersion;
  comments?: string;
}

export interface AlCreateFinancialInstrumentOnchainData {
  symbol: string;
  name?: string;
  simpleCustomMetadata?: Record<string, string | number | boolean>;
  decimals?: number;
}

export interface AlCreateFinancialInstrumentOffchainData {
  description?: string;
  simpleCustomMetadata?: Record<string, string | number | boolean>;
  logo?: AlOffchainFile;
  complexCustomMetadata?: Record<string, unknown>;
}

/**
 * Inputs for the setup of the new financial instrument. `mintAccount` and
 * `existingMintAccount` are mutually exclusive.
 */
export interface AlCreateFinancialInstrumentItemData {
  mintAccount?: AlCreateFinancialInstrumentMintAccount;
  existingMintAccount?: AlAccountLookup;
  mintAuthority: AlAccountLookup;
  version?: AlTokenVersion;
  alreadyOnChain?: boolean;
  updateAuthority?: AlAccountLookup;
  onchainData?: AlCreateFinancialInstrumentOnchainData;
  offchainData?: AlCreateFinancialInstrumentOffchainData;
  freezeAuthority?: AlAccountLookup;
  defaultPositionState?: "INITIALIZED" | "FROZEN";
  permanentDelegateAuthority?: AlAccountLookup;
  closingAuthority?: AlAccountLookup;
  pausableAuthority?: AlAccountLookup;
  paused?: boolean;
}

export interface AlCreateFinancialInstrumentRequest {
  itemData: AlCreateFinancialInstrumentItemData;
  tenancyConfig?: AlTenancyConfig;
}

export interface AlCreateFinancialInstrumentResponse {
  newFinancialInstrument: {
    onchainId: string;
    offchainId: string;
    alId?: AlId;
  };
  svmTransaction?: AlSvmTransactionResult;
}

export interface AlFetchFinancialInstrumentRequest {
  itemData: AlAccountLookup;
  tenancyConfig?: AlTenancyConfig;
}

export interface AlAccountOnchainCompact {
  id: string;
  lastTransactionId?: string;
  lastTransactionAt?: string;
}

export interface AlAccountOnchainDetailed extends AlAccountOnchainCompact {
  creationTransactionId?: string;
  creationTransactionAt?: string;
}

export interface AlAccountOffchainDetailed {
  id: string;
  type: string;
  code: string;
  alId?: AlId;
  organizationExternalId?: string;
  accountNumber?: string;
  name?: string;
  balance?: AlSvmValueResult;
  tokenDecimals?: number;
  lastTransactionId?: string;
  creationTransactionId?: string;
}

export interface AlAccountResponseDetailed {
  onchain?: AlAccountOnchainDetailed;
  offchain: AlAccountOffchainDetailed;
  managed: boolean;
  status: "ACTIVE" | "CLOSED";
  tenantOrganizationId: string;
}

export interface AlFinancialInstrumentBase<TAuthority> {
  version: AlTokenVersion;
  onchainData?: Record<string, unknown>;
  offchainData?: Record<string, unknown>;
  updateAuthority?: TAuthority;
  freezeAuthority?: TAuthority;
  defaultPositionState?: "INITIALIZED" | "FROZEN";
  permanentDelegateAuthority?: TAuthority;
  closingAuthority?: TAuthority;
  pausableAuthority?: TAuthority;
}

export interface AlFinancialInstrumentDetailed
  extends AlFinancialInstrumentBase<AlAccountResponseDetailed> {
  mintAccount: AlAccountResponseDetailed;
  mintAuthority: AlAccountResponseDetailed;
}

export type AlFetchFinancialInstrumentResponse = AlFinancialInstrumentDetailed;

export interface AlFetchFinancialInstrumentCirculatingSupplyRequest {
  itemData: {
    financialInstrument: AlAccountLookup;
    asOf?: string;
    circulatingSupplyType?: "ONCHAIN" | "OFFCHAIN";
  };
  tenancyConfig?: AlTenancyConfig;
}

export interface AlFetchFinancialInstrumentCirculatingSupplyResponse {
  onchainCirculatingSupply?: AlSvmValueResult;
  offchainCirculatingSupply?: AlSvmValueResult;
  outOfBalance?: boolean;
}

export type AlFinancialInstrumentDetailLevel = "detailed" | "compact" | "identifiers";

export interface AlFetchFinancialInstrumentsRequest {
  itemQuery: AlItemsQuery;
  tenancyConfig?: AlTenancyConfig;
}

export interface AlAccountResponseIdentifiers {
  managed: boolean;
  onchain: {
    id: string;
  };
  offchain: {
    id: string;
  };
  tenantOrganizationId: string;
}

export interface AlAccountOffchainCompact {
  id: string;
  lastTransactionId: string;
  type: string;
  code: string;
  alId?: AlId;
  organizationExternalId?: string;
  accountNumber?: string;
}

export interface AlAccountResponseCompact {
  onchain: AlAccountOnchainCompact;
  offchain: AlAccountOffchainCompact;
  managed: boolean;
  tenantOrganizationId: string;
  status: "ACTIVE" | "CLOSED";
}

export interface AlFinancialInstrumentCompact
  extends AlFinancialInstrumentBase<AlAccountResponseIdentifiers> {
  mintAccount: AlAccountResponseCompact;
  mintAuthority: AlAccountResponseIdentifiers;
}

export interface AlFinancialInstrumentIdentifiers {
  mintAccount: AlAccountResponseIdentifiers;
  version: AlTokenVersion;
}

export interface AlFinancialInstrumentItemByDetailLevel {
  detailed: AlFinancialInstrumentDetailed;
  compact: AlFinancialInstrumentCompact;
  identifiers: AlFinancialInstrumentIdentifiers;
}

export interface AlFetchFinancialInstrumentsResponse<
  TDetailLevel extends AlFinancialInstrumentDetailLevel,
> {
  count: number;
  items: AlFinancialInstrumentItemByDetailLevel[TDetailLevel][];
}

export interface AlUpdateFinancialInstrumentOnchainData {
  symbol?: string;
  name?: string;
  simpleCustomMetadata?: Record<string, string | number | boolean>;
}

export interface AlUpdateFinancialInstrumentOffchainData {
  description: string;
  simpleCustomMetadata?: Record<string, string | number | boolean>;
  logo: AlOffchainFile;
  complexCustomMetadata?: Record<string, unknown>;
}

export interface AlUpdateFinancialInstrumentItemData {
  mintAccount: AlAccountLookup;
  updateAuthority?: AlAccountLookup;
  freezeAuthority?: AlAccountLookup;
  mintAccountOffchainReferences?: AlOffchainReferences;
  onchainData?: AlUpdateFinancialInstrumentOnchainData;
  offchainData?: AlUpdateFinancialInstrumentOffchainData;
  defaultPositionState?: "INITIALIZED" | "FROZEN";
  paused?: boolean;
  newClosingAuthority?: AlAccountLookup;
  currentClosingAuthority?: AlAccountLookup;
  newPausableAuthority?: AlAccountLookup;
  currentPausableAuthority?: AlAccountLookup;
}

export interface AlUpdateFinancialInstrumentRequest {
  itemData: AlUpdateFinancialInstrumentItemData;
  tenancyConfig?: AlTenancyConfig;
}

export interface AlUpdateFinancialInstrumentResponse {
  updatedFinancialInstrument: AlSvmEntityResult;
  svmTransaction: AlSvmTransactionResult;
}

export interface AlCloseFinancialInstrumentRequest {
  itemData: {
    financialInstrumentToClose: AlAccountLookup;
    refundDestination?: AlAccountLookup;
    closeAuthority?: AlAccountLookup;
  };
  tenancyConfig?: AlTenancyConfig;
}

export interface AlCloseFinancialInstrumentResponse {
  closedFinancialInstrument: AlSvmEntityResult;
  svmTransaction?: AlSvmTransactionResult;
}

export interface AlPauseFinancialInstrumentRequest {
  itemData: {
    financialInstrument: AlAccountLookup;
    pausableAuthority?: AlAccountLookup;
  };
  tenancyConfig?: AlTenancyConfig;
}

export type AlPauseFinancialInstrumentResponse = AlSvmTransactionResult;

export interface AlUnpauseFinancialInstrumentRequest {
  itemData: {
    financialInstrument: AlAccountLookup;
    pausableAuthority?: AlAccountLookup;
  };
  tenancyConfig?: AlTenancyConfig;
}

export type AlUnpauseFinancialInstrumentResponse = AlSvmTransactionResult;

export type AlTokenExtension =
  | "PERMANENT_DELEGATE"
  | "MINT_CLOSE"
  | "DEFAULT_ACCOUNT_STATE"
  | "SCALED_UI_AMOUNT"
  | "PAUSABLE"
  | "TRANSFER_HOOK"
  | "CONFIDENTIAL_TRANSFER"
  | "CONFIDENTAL_MINT_BURN";

export interface AlCalculateTokenExtensionsRequest {
  extensions: AlTokenExtension[];
  metadata?: Record<string, unknown>;
}

export interface AlCalculateTokenExtensionsResponse {
  mintAccountSize: number;
  estimatedRent: AlSvmValueResult;
}

/**
 * Creates or onboards a financial instrument in Vulcan Forge and, when
 * requested, creates it onchain.
 *
 * @param service - Authenticated AlphaLedger service used to send the request.
 * @param body - Typed financial-instrument creation payload.
 * @param svmCluster - Target SVM network, omitted to use the tenant default.
 * @returns The created financial-instrument identifiers and optional SVM transaction result.
 */
export async function createFinancialInstrument(
  service: AlphaLedgerService,
  body: AlCreateFinancialInstrumentRequest,
  svmCluster?: AlSvmCluster
): Promise<AlCreateFinancialInstrumentResponse> {
  return service.request<AlCreateFinancialInstrumentResponse>(
    "POST",
    "/api/v1/financial-instruments",
    body,
    svmCluster
  );
}

/**
 * Fetches the detailed representation of one financial instrument.
 *
 * @param service - Authenticated AlphaLedger service used to send the request.
 * @param body - Typed lookup payload for the financial instrument.
 * @param svmCluster - Target SVM network, omitted to use the tenant default.
 * @returns The detailed financial-instrument representation.
 */
export async function fetchFinancialInstrument(
  service: AlphaLedgerService,
  body: AlFetchFinancialInstrumentRequest,
  svmCluster?: AlSvmCluster
): Promise<AlFetchFinancialInstrumentResponse> {
  return service.request<AlFetchFinancialInstrumentResponse>(
    "POST",
    "/api/v1/financial-instruments/single",
    body,
    svmCluster
  );
}

/**
 * Fetches the onchain, offchain, or combined circulating supply for one
 * financial instrument.
 *
 * @param service - Authenticated AlphaLedger service used to send the request.
 * @param body - Typed circulating-supply lookup payload.
 * @param svmCluster - Target SVM network, omitted to use the tenant default.
 * @returns The requested circulating-supply values and balance indicator.
 */
export async function fetchFinancialInstrumentCirculatingSupply(
  service: AlphaLedgerService,
  body: AlFetchFinancialInstrumentCirculatingSupplyRequest,
  svmCluster?: AlSvmCluster
): Promise<AlFetchFinancialInstrumentCirculatingSupplyResponse> {
  return service.request<AlFetchFinancialInstrumentCirculatingSupplyResponse>(
    "POST",
    "/api/v1/financial-instruments/single/circulating-supply",
    body,
    svmCluster
  );
}

/**
 * Fetches financial instruments matching a paginated filter and sort query.
 *
 * @param service - Authenticated AlphaLedger service used to send the request.
 * @param detailLevel - Response detail level encoded in the endpoint path; narrows the item type of the response.
 * @param body - Typed bulk financial-instrument query.
 * @param svmCluster - Target SVM network, omitted to use the tenant default.
 * @returns The matching financial instruments at the requested detail level and total count.
 */
export async function fetchFinancialInstruments<
  TDetailLevel extends AlFinancialInstrumentDetailLevel,
>(
  service: AlphaLedgerService,
  detailLevel: TDetailLevel,
  body: AlFetchFinancialInstrumentsRequest,
  svmCluster?: AlSvmCluster
): Promise<AlFetchFinancialInstrumentsResponse<TDetailLevel>> {
  return service.request<AlFetchFinancialInstrumentsResponse<TDetailLevel>>(
    "POST",
    `/api/v1/financial-instruments/bulk/${detailLevel}`,
    body,
    svmCluster
  );
}

/**
 * Updates mutable onchain and offchain properties for a financial instrument.
 *
 * @param service - Authenticated AlphaLedger service used to send the request.
 * @param body - Typed financial-instrument update payload.
 * @param svmCluster - Target SVM network, omitted to use the tenant default.
 * @returns The updated entity identifiers and SVM transaction result.
 */
export async function updateFinancialInstrument(
  service: AlphaLedgerService,
  body: AlUpdateFinancialInstrumentRequest,
  svmCluster?: AlSvmCluster
): Promise<AlUpdateFinancialInstrumentResponse> {
  return service.request<AlUpdateFinancialInstrumentResponse>(
    "PATCH",
    "/api/v1/financial-instruments",
    body,
    svmCluster
  );
}

/**
 * Closes a financial instrument and reclaims its network-currency rent when
 * applicable.
 *
 * @param service - Authenticated AlphaLedger service used to send the request.
 * @param body - Typed close payload with the instrument and optional authorities.
 * @param svmCluster - Target SVM network, omitted to use the tenant default.
 * @returns The closed entity identifiers and optional SVM transaction result.
 */
export async function closeFinancialInstrument(
  service: AlphaLedgerService,
  body: AlCloseFinancialInstrumentRequest,
  svmCluster?: AlSvmCluster
): Promise<AlCloseFinancialInstrumentResponse> {
  return service.request<AlCloseFinancialInstrumentResponse>(
    "PATCH",
    "/api/v1/financial-instruments/close",
    body,
    svmCluster
  );
}

/**
 * Pauses activity on a TOKEN_2022 financial instrument.
 *
 * @param service - Authenticated AlphaLedger service used to send the request.
 * @param body - Typed pause payload for the instrument and pausable authority.
 * @param svmCluster - Target SVM network, omitted to use the tenant default.
 * @returns The SVM transaction result that paused the instrument.
 */
export async function pauseFinancialInstrument(
  service: AlphaLedgerService,
  body: AlPauseFinancialInstrumentRequest,
  svmCluster?: AlSvmCluster
): Promise<AlPauseFinancialInstrumentResponse> {
  return service.request<AlPauseFinancialInstrumentResponse>(
    "PATCH",
    "/api/v1/financial-instruments/pause",
    body,
    svmCluster
  );
}

/**
 * Unpauses activity on a TOKEN_2022 financial instrument.
 *
 * @param service - Authenticated AlphaLedger service used to send the request.
 * @param body - Typed unpause payload for the instrument and pausable authority.
 * @param svmCluster - Target SVM network, omitted to use the tenant default.
 * @returns The SVM transaction result that unpaused the instrument.
 */
export async function unpauseFinancialInstrument(
  service: AlphaLedgerService,
  body: AlUnpauseFinancialInstrumentRequest,
  svmCluster?: AlSvmCluster
): Promise<AlUnpauseFinancialInstrumentResponse> {
  return service.request<AlUnpauseFinancialInstrumentResponse>(
    "PATCH",
    "/api/v1/financial-instruments/unpause",
    body,
    svmCluster
  );
}

/**
 * Calculates mint-account size and estimated rent for Token-2022 extensions
 * and metadata.
 *
 * @param service - Authenticated AlphaLedger service used to send the request.
 * @param body - Typed extension and metadata inputs for the calculation.
 * @param svmCluster - Target SVM network, omitted to use the tenant default.
 * @returns The required mint-account size and estimated rent.
 */
export async function calculateTokenExtensions(
  service: AlphaLedgerService,
  body: AlCalculateTokenExtensionsRequest,
  svmCluster?: AlSvmCluster
): Promise<AlCalculateTokenExtensionsResponse> {
  return service.request<AlCalculateTokenExtensionsResponse>(
    "POST",
    "/api/v1/financial-instruments/token-extensions-calculator",
    body,
    svmCluster
  );
}
