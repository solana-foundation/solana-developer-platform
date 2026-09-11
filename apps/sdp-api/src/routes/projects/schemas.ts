import { assertReachableTenantEndpoint } from "@sdp/rpc/byok";
import { PROJECT_RPC_PROVIDERS } from "@sdp/types";
import { z } from "zod";

const projectRpcProviderSchema = z.enum(PROJECT_RPC_PROVIDERS);

/**
 * The stored value is fetched by the relay and by `/v1/rpc/test`, so it faces
 * the same submission rules as a BYOK connection endpoint: https, no embedded
 * credentials, no host the egress guard would refuse to dial.
 */
export const projectRpcEndpointSchema = z
  .string()
  .max(2048)
  .superRefine((value, ctx) => {
    try {
      assertReachableTenantEndpoint(value);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: error instanceof Error ? error.message : "Invalid RPC endpoint",
      });
    }
  });

export const updateProjectSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  settings: z
    .object({
      rpcProvider: projectRpcProviderSchema.optional(),
      rpcEndpoint: projectRpcEndpointSchema.optional(),
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
