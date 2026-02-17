import { z } from "./base";

const rpcProviderIdSchema = z.enum(["triton", "helius", "alchemy", "default"]).openapi({
  description: "Resolved RPC provider identifier.",
  example: "default",
});

const rpcSelectionModeSchema = z
  .enum(["organization_provider", "round_robin_default"])
  .openapi({
    description: "How the relay selected the provider endpoint.",
    example: "round_robin_default",
  });

const rpcProviderStatsSchema = z
  .object({
    requestsTotal: z.number().int().nonnegative().openapi({ example: 18 }),
    transactionRequests: z.number().int().nonnegative().openapi({ example: 5 }),
    errorsTotal: z.number().int().nonnegative().openapi({ example: 1 }),
    averageLatencyMs: z.number().int().nonnegative().openapi({ example: 142 }),
    lastRequestAt: z.string().datetime().nullable().openapi({
      description: "Timestamp of the most recent relay request for this provider.",
      example: "2026-02-17T19:20:00.000Z",
    }),
    lastStatusCode: z.number().int().nullable().openapi({ example: 200 }),
    lastMethod: z.string().nullable().openapi({ example: "sendTransaction" }),
    origins: z.record(z.number().int().nonnegative()).openapi({
      description: "Best-effort per-origin request counters.",
      example: { "https://dashboard.example.com": 12 },
    }),
  })
  .openapi({ description: "Aggregated telemetry for an RPC provider." });

const rpcProviderStatusSchema = z
  .object({
    id: z.enum(["triton", "helius", "alchemy", "default"]).openapi({ example: "triton" }),
    endpoint: z.string().openapi({
      description: "Provider endpoint with secrets redacted.",
      example: "https://mainnet.helius-rpc.com/?api-key=***",
    }),
    stats: rpcProviderStatsSchema,
  })
  .openapi({ description: "Configured managed RPC provider and telemetry." });

export const rpcProvidersResponseSchema = z
  .object({
    providers: z.array(rpcProviderStatusSchema),
    selected: z.object({
      providerId: rpcProviderIdSchema,
      projectId: z.string().nullable().openapi({ example: "prj_example" }),
      selectionMode: rpcSelectionModeSchema,
      endpoint: z.string().openapi({
        description: "Selected endpoint with secrets redacted.",
        example: "https://rpc.example.com/?api-key=***",
      }),
      stats: rpcProviderStatsSchema,
    }),
    roundRobinOrder: z.array(z.enum(["triton", "helius", "alchemy", "default"])).openapi({
      description: "Managed provider order used by round-robin fallback.",
      example: ["triton", "helius", "alchemy", "default"],
    }),
  })
  .openapi({ description: "RPC provider list and selection summary." });

const rpcRelayPayloadSchema = z
  .union([
    z.object({ method: z.string().min(1) }).passthrough(),
    z.array(z.object({ method: z.string().min(1) }).passthrough()).min(1),
  ])
  .openapi({
    description: "JSON-RPC payload forwarded to upstream provider.",
    example: { jsonrpc: "2.0", id: 1, method: "getLatestBlockhash", params: [] },
  });

export const rpcRelayRequestSchema = rpcRelayPayloadSchema;

export const rpcRelayResponseSchema = z
  .object({
    provider: z.object({
      id: rpcProviderIdSchema,
      selectionMode: rpcSelectionModeSchema,
      projectId: z.string().nullable().openapi({ example: "prj_example" }),
      endpoint: z.string().openapi({
        description: "Selected endpoint with secrets redacted.",
        example: "https://mainnet.helius-rpc.com/?api-key=***",
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
