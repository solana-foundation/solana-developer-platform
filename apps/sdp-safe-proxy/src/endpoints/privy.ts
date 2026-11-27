import { z } from "zod";
import { type AllowedEndpoint, type ProviderDeclaration, token } from "./endpoint";

const listWallets: AllowedEndpoint = {
  method: "GET",
  path: "/v1/wallets",
  parameters: {},
  query: [],
  callers: ["api"],
  requestHeaders: [],
};

const readWallet: AllowedEndpoint = {
  method: "GET",
  path: "/v1/wallets/{wallet}",
  parameters: { wallet: token },
  query: [],
  callers: ["api", "cron"],
  requestHeaders: [],
};

const createWallet: AllowedEndpoint = {
  method: "POST",
  path: "/v1/wallets",
  parameters: {},
  query: [],
  callers: ["api"],
  requestHeaders: ["privy-idempotency-key"],
};

const signTransaction: AllowedEndpoint = {
  method: "POST",
  path: "/v1/wallets/{wallet}/rpc",
  parameters: { wallet: token },
  query: [],
  callers: ["api", "cron"],
  requestHeaders: [],
  body: z.looseObject({ method: z.literal("signTransaction") }),
};

const signMessage: AllowedEndpoint = {
  method: "POST",
  path: "/v1/wallets/{wallet}/rpc",
  parameters: { wallet: token },
  query: [],
  callers: ["api", "cron"],
  requestHeaders: [],
  body: z.looseObject({ method: z.literal("signMessage") }),
};

const endpoints: readonly AllowedEndpoint[] = [
  listWallets,
  readWallet,
  createWallet,
  signTransaction,
  signMessage,
];

export const PRIVY = {
  hosts: { devnet: "api.privy.io", "mainnet-beta": null },
  endpoints,
} as const satisfies ProviderDeclaration;
