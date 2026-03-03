import { ORGANIZATION_RPC_PROVIDERS } from "@sdp/types";
import { z } from "zod";

const createOrgCustodySchema = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("fireblocks"),
    apiBaseUrl: z.string().url().optional(),
    assetId: z.string().min(1).optional(),
    vaultAccountId: z.string().min(1).optional(),
  }),
  z.object({
    provider: z.literal("privy"),
    apiBaseUrl: z.string().url().optional(),
    requestDelayMs: z.number().int().min(0).max(3000).optional(),
  }),
  z.object({
    provider: z.literal("coinbase_cdp"),
    apiBaseUrl: z.string().url().optional(),
    network: z.enum(["solana", "solana-devnet"]).optional(),
    walletAddress: z.string().min(32).max(44).optional(),
    accountPolicy: z
      .string()
      .regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/)
      .optional(),
  }),
  z.object({
    provider: z.literal("para"),
    apiBaseUrl: z.string().url().optional(),
    requestDelayMs: z.number().int().min(0).max(3000).optional(),
    walletId: z.string().min(1).optional(),
  }),
  z.object({
    provider: z.literal("turnkey"),
    apiBaseUrl: z.string().url().optional(),
    requestDelayMs: z.number().int().min(0).max(3000).optional(),
    privateKeyId: z.string().min(1).optional(),
  }),
  z.object({
    provider: z.literal("dfns"),
    apiBaseUrl: z.string().url().optional(),
    network: z.enum(["Solana", "SolanaDevnet"]).optional(),
    walletId: z.string().min(1).optional(),
    signingKeyId: z.string().min(1).optional(),
  }),
  z.object({
    provider: z.literal("anchorage"),
    apiBaseUrl: z.string().url().optional(),
    walletId: z.string().min(1).optional(),
    network: z.enum(["solana", "solana-devnet"]).optional(),
  }),
]);

export const createOrgSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z
    .string()
    .min(3)
    .max(50)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  email: z.string().email(),
  returnFullApiKey: z.boolean().optional(),
  custody: createOrgCustodySchema.optional(),
});

export const updateOrgSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  settings: z
    .object({
      rpcProvider: z.enum(ORGANIZATION_RPC_PROVIDERS).optional(),
      defaultEnvironment: z.enum(["sandbox", "production"]).optional(),
      allowedIpAddresses: z.array(z.string()).optional(),
    })
    .optional(),
});
