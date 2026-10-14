import { createServer } from "node:http";
import { z } from "zod";

const fixtureModeSchema = z.enum(["zero", "unavailable"]);
const fixtureControlSchema = z.object({ mode: fixtureModeSchema });
const fixtureStateSchema = z.object({
  fixture: z.literal("wallet-identity"),
  mode: fixtureModeSchema,
  calls: z.record(z.string(), z.number().int().nonnegative()),
});
const rpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  method: z.string().min(1),
  params: z.array(z.json()).optional(),
});
const rpcEnvelopeSchema = z.union([rpcRequestSchema, z.array(rpcRequestSchema).min(1)]);
const multipleAccountsRequestSchema = rpcRequestSchema.extend({
  method: z.literal("getMultipleAccounts"),
  params: z.tuple([z.array(z.string())]).rest(z.json()),
});

/** Loopback-only balance provider fixture; no method can fund, sign or submit. */
export async function startWalletIdentityRpc(port: number) {
  let mode: z.infer<typeof fixtureModeSchema> = "zero";
  const calls: Record<string, number> = {};
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    response.setHeader("Content-Type", "application/json");
    try {
      if (request.url === "/__wallet_identity/state") {
        if (request.method === "POST") {
          mode = fixtureControlSchema.parse(JSON.parse(body)).mode;
        }
        response.end(JSON.stringify({ fixture: "wallet-identity", mode, calls }));
        return;
      }
      const reply = (rpc: z.infer<typeof rpcRequestSchema>) => {
        calls[rpc.method] = (calls[rpc.method] ?? 0) + 1;
        const envelope = { jsonrpc: "2.0", id: rpc.id };
        if (mode === "unavailable") {
          return {
            ...envelope,
            error: { code: -32005, message: "Controlled balance read failure" },
          };
        }
        const context = { slot: 4321 };
        switch (rpc.method) {
          case "getMultipleAccounts": {
            const {
              params: [addresses],
            } = multipleAccountsRequestSchema.parse(rpc);
            return { ...envelope, result: { context, value: addresses.map(() => null) } };
          }
          case "getAccountInfo":
            return { ...envelope, result: { context, value: null } };
          case "getTokenAccountsByOwner":
            return { ...envelope, result: { context, value: [] } };
          case "getBalance":
            return { ...envelope, result: { context, value: 0 } };
          case "getSlot":
          case "getBlockHeight":
            return { ...envelope, result: 4321 };
          case "getSignaturesForAddress":
            return { ...envelope, result: [] };
          default:
            return {
              ...envelope,
              error: { code: -32601, message: "Unsupported read-only fixture method" },
            };
        }
      };
      const rpc = rpcEnvelopeSchema.parse(JSON.parse(body));
      response.end(JSON.stringify(Array.isArray(rpc) ? rpc.map(reply) : reply(rpc)));
    } catch {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: "Invalid wallet identity fixture request" }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

export async function setWalletIdentityRpcMode(mode: z.infer<typeof fixtureModeSchema>) {
  const configuredUrl = process.env.SOLANA_RPC_URL;
  if (!configuredUrl) throw new Error("Wallet identity E2E requires its read-only RPC fixture");
  const url = new URL(configuredUrl);
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error("Wallet identity RPC fixture must be on loopback");
  }
  url.pathname = "/__wallet_identity/state";
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  if (!response.ok) throw new Error("Wallet identity RPC fixture did not accept its mode");
  const state = fixtureStateSchema.parse(await response.json());
  if (state.mode !== mode) {
    throw new Error("RPC endpoint is not the wallet identity read-only fixture");
  }
  return state;
}
