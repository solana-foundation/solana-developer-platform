import {
  type AllowedEndpoint,
  endpoint,
  type PathParameter,
  type ProviderDeclaration,
} from "./endpoint";

const VAULT = { format: "digits" } as const satisfies PathParameter;
const ASSET = { format: "one_of", values: ["SOL", "SOL_TEST"] } as const satisfies PathParameter;
const TRANSACTION = { format: "token" } as const satisfies PathParameter;

const readVaultAddresses = endpoint({
  method: "GET",
  path: "/v1/vault/accounts/{vault}/{asset}/addresses_paginated",
  parameters: { vault: VAULT, asset: ASSET },
  query: ["limit"],
  kind: "read",
  callers: ["api", "cron"],
  requestHeaders: [],
  status: "active",
});

const listVaults = endpoint({
  method: "GET",
  path: "/v1/vault/accounts_paged",
  parameters: {},
  query: ["limit", "assetId", "after", "namePrefix"],
  kind: "read",
  callers: ["api"],
  requestHeaders: [],
  status: "active",
});

const readVault = endpoint({
  method: "GET",
  path: "/v1/vault/accounts/{vault}",
  parameters: { vault: VAULT },
  query: [],
  kind: "read",
  callers: ["api"],
  requestHeaders: [],
  status: "active",
});

const listSupportedAssets = endpoint({
  method: "GET",
  path: "/v1/supported_assets",
  parameters: {},
  query: [],
  kind: "read",
  callers: ["api"],
  requestHeaders: [],
  status: "active",
});

const listExternalWallets = endpoint({
  method: "GET",
  path: "/v1/external_wallets",
  parameters: {},
  query: [],
  kind: "read",
  callers: ["api"],
  requestHeaders: [],
  status: "active",
});

const listInternalWallets = endpoint({
  method: "GET",
  path: "/v1/internal_wallets",
  parameters: {},
  query: [],
  kind: "read",
  callers: ["api"],
  requestHeaders: [],
  status: "active",
});

const readTransaction = endpoint({
  method: "GET",
  path: "/v1/transactions/{transaction}",
  parameters: { transaction: TRANSACTION },
  query: [],
  kind: "read",
  callers: ["api", "cron"],
  requestHeaders: [],
  status: "active",
});

const readTransactionByExternalId = endpoint({
  method: "GET",
  path: "/v1/transactions/external_tx_id/{externalTxId}",
  parameters: { externalTxId: { format: "token" } },
  query: [],
  kind: "read",
  callers: ["api", "cron"],
  requestHeaders: [],
  status: "active",
});

const createVault = endpoint({
  method: "POST",
  path: "/v1/vault/accounts",
  parameters: {},
  query: [],
  kind: "change",
  callers: ["api"],
  requestHeaders: ["idempotency-key"],
  status: "active",
  idempotency: {
    key: { in: "header", name: "idempotency-key" },
    dedupe: { lasts: "hours", hours: 24 },
    read: listVaults,
  },
});

const activateVaultAsset = endpoint({
  method: "POST",
  path: "/v1/vault/accounts/{vault}/{asset}",
  parameters: { vault: VAULT, asset: ASSET },
  query: [],
  kind: "change",
  callers: ["api"],
  requestHeaders: ["idempotency-key"],
  status: "active",
  idempotency: {
    key: { in: "header", name: "idempotency-key" },
    dedupe: { lasts: "hours", hours: 24 },
    read: readVaultAddresses,
  },
});

const cancelTransaction = endpoint({
  method: "POST",
  path: "/v1/transactions/{transaction}/cancel",
  parameters: { transaction: TRANSACTION },
  query: [],
  kind: "change",
  callers: ["api", "cron"],
  requestHeaders: [],
  status: "active",
  idempotency: {
    key: { in: "path" },
    dedupe: { lasts: "permanent" },
    read: readTransaction,
  },
});

const createSigningProposal = endpoint({
  method: "POST",
  path: "/v1/transactions",
  parameters: {},
  query: [],
  kind: "sign",
  callers: ["api", "cron"],
  requestHeaders: [],
  status: "active",
  body: { field: "operation", values: ["RAW", "PROGRAM_CALL"] },
  idempotency: {
    key: { in: "body", field: "externalTxId" },
    dedupe: { lasts: "permanent" },
    read: readTransactionByExternalId,
  },
});

const createTransfer = endpoint({
  method: "POST",
  path: "/v1/transactions",
  parameters: {},
  query: [],
  kind: "change",
  callers: ["api"],
  requestHeaders: [],
  status: "active",
  body: { field: "operation", values: ["TRANSFER"] },
  idempotency: {
    key: { in: "body", field: "externalTxId" },
    dedupe: { lasts: "permanent" },
    read: readTransactionByExternalId,
  },
});

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
  authScheme: "fireblocks_jwt",
  endpoints,
} as const satisfies ProviderDeclaration;
