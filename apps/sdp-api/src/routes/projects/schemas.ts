import { PROJECT_RPC_PROVIDERS } from "@sdp/types";
import { z } from "zod";

const projectRpcProviderSchema = z.enum(PROJECT_RPC_PROVIDERS);

export const updateProjectSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  settings: z
    .object({
      rpcProvider: projectRpcProviderSchema.optional(),
      rpcEndpoint: z.string().url().optional(),
      webhookUrl: z.string().url().optional(),
      metadata: z.record(z.string(), z.string()).optional(),
    })
    .nullable()
    .optional(),
});

export const addMemberSchema = z.object({
  userId: z.string(),
  role: z.enum(["admin", "developer", "viewer"]).optional(),
});

export const updateMemberSchema = z.object({
  role: z.enum(["admin", "developer", "viewer"]),
});
