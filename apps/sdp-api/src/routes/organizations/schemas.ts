import { ORGANIZATION_RPC_PROVIDERS } from "@sdp/types";
import { z } from "zod";

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
