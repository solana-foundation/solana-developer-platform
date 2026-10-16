import { ORGANIZATION_RPC_PROVIDERS } from "@sdp/types";
import {
  RPC_RELAY_MAX_BATCH,
  rpcRelayPayloadSchema as relayPayloadSchemaBase,
} from "../../routes/rpc/schemas";
import { z } from "./base";

const managedRpcProviderIdSchema = z.enum(ORGANIZATION_RPC_PROVIDERS).openapi({
  description: "Managed RPC provider identifier.",
  example: "default",
});

const rpcRelayPayloadSchema = relayPayloadSchemaBase.openapi({
  description:
    "JSON-RPC payload proxied to a managed upstream provider. Methods are limited to the Solana JSON-RPC API; a batch carries at most " +
    String(RPC_RELAY_MAX_BATCH) +
    " requests.",
  example: { jsonrpc: "2.0", id: 1, method: "getLatestBlockhash", params: [] },
});

export const rpcRelayRequestSchema = rpcRelayPayloadSchema;

export const rpcRelayResponseSchema = z
  .object({
    provider: z.object({
      id: managedRpcProviderIdSchema,
      endpoint: z.string().openapi({
        description: "The managed endpoint that served the request, with secrets redacted.",
        example: "https://rpc.provider.example.com/?api-key=***",
      }),
    }),
    upstream: z.object({
      ok: z.boolean().openapi({ example: true }),
      status: z.number().int().openapi({ example: 200 }),
      statusText: z.string().openapi({ example: "OK" }),
    }),
    methods: z.array(z.string()).openapi({ example: ["getLatestBlockhash"] }),
    response: z.unknown().openapi({
      description: "Raw upstream RPC response payload.",
    }),
  })
  .openapi({ description: "RPC relay execution result." });
