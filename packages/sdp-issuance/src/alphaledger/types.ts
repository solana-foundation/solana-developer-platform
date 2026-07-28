type AlIdCategoryTypePair =
  | `FI${"BCD" | "CBD" | "CLN" | "L" | "MBD" | "MLN" | "AUTO" | "MPP" | "MLO"}`
  | `FND${"PF"}`
  | `EQY${"STC" | "ETF"}`
  | `FX${"FC" | "SC"}`
  | `CR${"PT" | "NFT" | "L1T" | "L2T"}`;

/**
 * AlphaLedger instrument identifier: `AL` + category/type short codes + sequence.
 * See {@link https://vulcan-forge-docs.alphaledger.com/api/v1/financial-instruments/create#al-id}
 */
export type AlId = `AL${AlIdCategoryTypePair}${string}`;

export type AlOffchainEntityType =
  | "WALLET"
  | "ASSET_TOKEN"
  | "CURRENCY_TOKEN"
  | "AUTHORITY"
  | "TOKEN_MANAGEMENT_AUTHORITY";

export type AlFinancialInstrumentType =
  | "MUNI_BOND"
  | "MUNI_LOAN"
  | "AUTO_LOAN"
  | "MUNI_PRIVATE_PLACEMENT"
  | "MUNI_LIMITED_OFFERING"
  | "BROKER_CD"
  | "CORPORATE_BOND"
  | "CORPORATE_LOAN"
  | "LOAN"
  | "PRIVATE_FUND"
  | "MUTUAL_FUND"
  | "STOCK"
  | "ETF"
  | "FIAT_CURRENCY"
  | "STABLECOIN"
  | "PROTOCOL_TOKEN"
  | "NFT"
  | "LAYER_1_TOKEN"
  | "LAYER_2_TOKEN";

export type AlTokenVersion = "SPL" | "TOKEN_2022";

export interface AlNewAlId {
  financialInstrumentType: AlFinancialInstrumentType;
}

export interface AlOffchainReferences {
  alId?: AlId;
  organizationExternalId?: string;
  accountNumber?: string;
  code?: string;
  type?: AlOffchainEntityType;
}

export interface AlAccountLookup {
  onchainId?: string;
  offchainId?: string;
  offchainReferences?: AlOffchainReferences;
  autoSign?: boolean;
  otherTenantOrganizationExternalId?: string;
  offPlatform?: boolean;
}

export interface AlTenancyConfig {
  overrideOrganizationExternalId: string;
}

export interface AlOffchainFile {
  copyFromUri?: string;
  fileName: string;
  contentType: string;
  type: "LOGO" | "DOCUMENT" | "IMAGE" | "COMPLEX_OFFCHAIN_METADATA";
}

export type AlSvmCluster =
  | "SOLANA_DEVNET"
  | "SOLANA_DEVNET_1"
  | "SOLANA_MAINNET_TESTING"
  | "SOLANA_MAINNET"
  | "SOLANA_ALPHALEDGER_SPE";

export interface AlSortModel {
  fieldName: string;
  sortDirection: "ASC" | "DESC";
}

export type AlFieldValueFilterDataType =
  | "TEXT"
  | "INTEGER"
  | "DECIMAL"
  | "TIMESTAMP"
  | "BOOLEAN"
  | "OFFCHAIN_ID"
  | "ONCHAIN_TXN_ID"
  | "ONCHAIN_ADDRESS_ID"
  | "OFFCHAIN_REFRENCE_TYPE";

export type AlFieldValueFilterType =
  | "EQUALS"
  | "NOT_EQUALS"
  | "CONTAINS"
  | "NOT_CONTAINS"
  | "IS_NULL"
  | "IS_NOT_NULL"
  | "STARTS_WITH"
  | "ENDS_WITH"
  | "IN_RANGE"
  | "GREATER_THAN_OR_EQUAL"
  | "GREATER_THAN"
  | "LESS_THAN_OR_EQUAL"
  | "LESS_THAN"
  | "IN";

export interface AlFieldValueFilter {
  dataType?: AlFieldValueFilterDataType;
  filterType: AlFieldValueFilterType;
  valueString?: string;
  valueNumber?: number;
  valueBoolean?: boolean;
  valuesString?: string[];
  valueFromString?: string;
  valueToString?: string;
  valueFromNumber?: number;
  valueToNumber?: number;
}

export interface AlFilterModel {
  fieldName: string;
  operator?: "AND" | "OR";
  filterValues: AlFieldValueFilter[];
}

export interface AlItemsQuery {
  limit?: number;
  skip?: number;
  filter?: AlFilterModel[];
  sort?: AlSortModel[];
}

export type AlSvmTransactionStatus =
  | "PREPARED"
  | "PARTIALLY_SIGNED"
  | "SIGNED"
  | "SUBMITTED"
  | "PROCESSED"
  | "CONFIRMED"
  | "FINALIZED"
  | "BLOCKCHAIN_ERROR"
  | "NON_BLOCKCHAIN_ERROR"
  | "CANCELLED"
  | "EXPIRED";

export interface AlSvmTransactionResult {
  success: boolean;
  offchainId: string;
  status: AlSvmTransactionStatus;
  onchainId?: string;
  confirmationsCount?: number;
  serializedMessage?: string;
  errorMessage?: string;
  txnTimestamp?: string;
}

export interface AlSvmValueResult {
  amount: number;
  lamports: number;
}

export interface AlSvmEntityResult {
  onchainId: string;
  offchainId: string;
}

export interface AlErrorResponse {
  requestId: string;
  errors: {
    code: string;
    message: string;
  }[];
}
