import { z } from "zod";
import { type AllowedEndpoint, digits, type ProviderDeclaration, token } from "./endpoint";

const ASSET = z.enum(["SOL", "SOL_TEST"]);

const readVaultAddresses: AllowedEndpoint = {
  method: "GET",
  path: "/v1/vault/accounts/{vault}/{asset}/addresses_paginated",
  parameters: { vault: digits, asset: ASSET },
  query: ["limit"],
  callers: ["api", "cron"],
  requestHeaders: [],
};

const listVaults: AllowedEndpoint = {
  method: "GET",
  path: "/v1/vault/accounts_paged",
  parameters: {},
  query: ["limit", "assetId", "after", "namePrefix"],
  callers: ["api"],
  requestHeaders: [],
};

const readVault: AllowedEndpoint = {
  method: "GET",
  path: "/v1/vault/accounts/{vault}",
  parameters: { vault: digits },
  query: [],
  callers: ["api"],
  requestHeaders: [],
};

const listSupportedAssets: AllowedEndpoint = {
  method: "GET",
  path: "/v1/supported_assets",
  parameters: {},
  query: [],
  callers: ["api"],
  requestHeaders: [],
};

const listExternalWallets: AllowedEndpoint = {
  method: "GET",
  path: "/v1/external_wallets",
  parameters: {},
  query: [],
  callers: ["api"],
  requestHeaders: [],
};

const listInternalWallets: AllowedEndpoint = {
  method: "GET",
  path: "/v1/internal_wallets",
  parameters: {},
  query: [],
  callers: ["api"],
  requestHeaders: [],
};

const readTransaction: AllowedEndpoint = {
  method: "GET",
  path: "/v1/transactions/{transaction}",
  parameters: { transaction: token },
  query: [],
  callers: ["api", "cron"],
  requestHeaders: [],
};

const readTransactionByExternalId: AllowedEndpoint = {
  method: "GET",
  path: "/v1/transactions/external_tx_id/{externalTxId}",
  parameters: { externalTxId: token },
  query: [],
  callers: ["api", "cron"],
  requestHeaders: [],
};

const createVault: AllowedEndpoint = {
  method: "POST",
  path: "/v1/vault/accounts",
  parameters: {},
  query: [],
  callers: ["api"],
  requestHeaders: ["idempotency-key"],
};

const activateVaultAsset: AllowedEndpoint = {
  method: "POST",
  path: "/v1/vault/accounts/{vault}/{asset}",
  parameters: { vault: digits, asset: ASSET },
  query: [],
  callers: ["api"],
  requestHeaders: ["idempotency-key"],
};

const cancelTransaction: AllowedEndpoint = {
  method: "POST",
  path: "/v1/transactions/{transaction}/cancel",
  parameters: { transaction: token },
  query: [],
  callers: ["api", "cron"],
  requestHeaders: [],
};

const createSigningProposal: AllowedEndpoint = {
  method: "POST",
  path: "/v1/transactions",
  parameters: {},
  query: [],
  callers: ["api", "cron"],
  requestHeaders: [],
  body: { field: "operation", values: ["RAW", "PROGRAM_CALL"] },
};

const createTransfer: AllowedEndpoint = {
  method: "POST",
  path: "/v1/transactions",
  parameters: {},
  query: [],
  callers: ["api"],
  requestHeaders: [],
  body: { field: "operation", values: ["TRANSFER"] },
};

const endpoints: readonly AllowedEndpoint[] = [
  readVaultAddresses,
  listVaults,
  readVault,
  listSupportedAssets,
  listExternalWallets,
  listInternalWallets,
  readTransaction,
  readTransactionByExternalId,
  createVault,
  activateVaultAsset,
  cancelTransaction,
  createSigningProposal,
  createTransfer,
];

export const FIREBLOCKS = {
  hosts: ["api.fireblocks.io"],
  endpoints,
} as const satisfies ProviderDeclaration;
