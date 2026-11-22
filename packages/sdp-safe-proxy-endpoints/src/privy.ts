import { type AllowedEndpoint, endpoint, type ProviderDeclaration } from "./endpoint";

const listWallets = endpoint({
  method: "GET",
  path: "/v1/wallets",
  parameters: {},
  query: [],
  kind: "read",
  callers: ["api"],
  requestHeaders: [],
  status: "active",
});

const readWallet = endpoint({
  method: "GET",
  path: "/v1/wallets/{wallet}",
  parameters: { wallet: { format: "token" } },
  query: [],
  kind: "read",
  callers: ["api", "cron"],
  requestHeaders: [],
  status: "active",
});

const createWallet = endpoint({
  method: "POST",
  path: "/v1/wallets",
  parameters: {},
  query: [],
  kind: "change",
  callers: ["api"],
  requestHeaders: ["privy-idempotency-key"],
  status: "active",
  idempotency: {
    key: { in: "header", name: "privy-idempotency-key" },
    dedupe: { lasts: "hours", hours: 24 },
    read: readWallet,
  },
});

const signTransaction = endpoint({
  method: "POST",
  path: "/v1/wallets/{wallet}/rpc",
  parameters: { wallet: { format: "token" } },
  query: [],
  kind: "sign",
  callers: ["api", "cron"],
  requestHeaders: [],
  status: "active",
  body: { field: "method", values: ["signTransaction"] },
});

const signMessage = endpoint({
  method: "POST",
  path: "/v1/wallets/{wallet}/rpc",
  parameters: { wallet: { format: "token" } },
  query: [],
  kind: "sign",
  callers: ["api", "cron"],
  requestHeaders: [],
  status: "active",
  body: { field: "method", values: ["signMessage"] },
});

const endpoints: readonly AllowedEndpoint[] = [
  listWallets,
  readWallet,
  createWallet,
  signTransaction,
  signMessage,
];

export const PRIVY = {
  hosts: ["api.privy.io"],
  authScheme: "privy_basic",
  endpoints,
} as const satisfies ProviderDeclaration;
