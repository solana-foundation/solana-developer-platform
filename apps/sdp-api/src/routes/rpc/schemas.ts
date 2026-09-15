import { z } from "zod";
import { SOLANA_RPC_METHODS } from "./solana-methods";

/**
 * A JSON-RPC batch is amplification against the upstream: one HTTP request
 * fans out into this many node calls, all charged to one admitted request.
 */
export const RPC_RELAY_MAX_BATCH = 20;

const rpcRequestSchema = z
  .object({
    method: z
      .string()
      .min(1)
      .refine((method) => SOLANA_RPC_METHODS.has(method), {
        message: "Method is not part of the Solana JSON-RPC API",
      }),
  })
  .passthrough();

export const rpcRelayPayloadSchema = z.union([
  rpcRequestSchema,
  z.array(rpcRequestSchema).min(1).max(RPC_RELAY_MAX_BATCH),
]);

export const rpcProjectQuerySchema = z.object({
  projectId: z.string().min(1).optional(),
});
