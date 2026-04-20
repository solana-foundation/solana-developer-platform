import { PROJECT_RPC_PROVIDERS } from "@sdp/types";
import { z } from "zod";

const projectRpcProviderSchema = z.enum(PROJECT_RPC_PROVIDERS);

export const createProjectSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  description: z.string().max(500).optional(),
  environment: z.enum(["sandbox", "beta", "production"]).optional(),
  settings: z
    .object({
      rpcProvider: projectRpcProviderSchema.optional(),
      rpcEndpoint: z.string().url().optional(),
      webhookUrl: z.string().url().optional(),
      metadata: z.record(z.string(), z.string()).optional(),
    })
    .optional()
    .superRefine((value, ctx) => {
      if (!value) {
        return;
      }

      if (value.rpcProvider === "custom" && !value.rpcEndpoint) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rpcEndpoint"],
          message: "rpcEndpoint is required when rpcProvider is custom",
        });
      }
    }),
});

export const updateProjectSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).nullable().optional(),
  environment: z.enum(["sandbox", "beta", "production"]).optional(),
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
