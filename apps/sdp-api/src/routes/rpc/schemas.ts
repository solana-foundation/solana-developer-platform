import { z } from "zod";

const rpcRequestSchema = z
  .object({
    method: z.string().min(1),
  })
  .passthrough();

export const rpcRelayPayloadSchema = z.union([rpcRequestSchema, z.array(rpcRequestSchema).min(1)]);

export const rpcProjectQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
});
