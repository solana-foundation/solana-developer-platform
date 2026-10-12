import { createServer } from "node:http";
import { SPL_TOKEN_PROGRAMS, WELL_KNOWN_TOKENS } from "@sdp/types";

/** Loopback-only balance provider fixture; no method can fund, sign or submit. */
export async function startWalletIdentityRpc(port: number, includeRecurringToken = false) {
  let mode: "zero" | "unavailable" = "zero";
  const calls: Record<string, number> = {};
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    response.setHeader("Content-Type", "application/json");
    try {
      if (request.url === "/__wallet_identity/state") {
        if (request.method === "POST") {
          const next = JSON.parse(body).mode;
          if (next !== "zero" && next !== "unavailable") throw new Error("Invalid fixture mode");
          mode = next;
        }
        response.end(JSON.stringify({ fixture: "wallet-identity", mode, calls }));
        return;
      }
      const reply = (rpc: { method: string; id: string | number; params?: unknown[] }) => {
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
            const addresses = rpc.params?.[0];
            if (!Array.isArray(addresses)) throw new Error("Expected account addresses");
            return { ...envelope, result: { context, value: addresses.map(() => null) } };
          }
          case "getAccountInfo":
            return { ...envelope, result: { context, value: null } };
          case "getTokenAccountsByOwner": {
            const filter = rpc.params?.[1];
            const isTokenProgram =
              typeof filter === "object" &&
              filter !== null &&
              "programId" in filter &&
              filter.programId === SPL_TOKEN_PROGRAMS["spl-token"];
            return {
              ...envelope,
              result: {
                context,
                // One synthetic base unit survives the balance reader's zero filter; no fixture method can fund or send.
                value:
                  includeRecurringToken && isTokenProgram
                    ? [
                        {
                          pubkey: "11111111111111111111111111111111",
                          account: {
                            data: {
                              parsed: {
                                info: {
                                  mint: WELL_KNOWN_TOKENS.USDC.mints.devnet.address,
                                  tokenAmount: {
                                    amount: "1",
                                    decimals: WELL_KNOWN_TOKENS.USDC.mints.devnet.decimals,
                                    uiAmount: 0.000001,
                                    uiAmountString: "0.000001",
                                  },
                                },
                              },
                            },
                          },
                        },
                      ]
                    : [],
              },
            };
          }
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
      const rpc = JSON.parse(body);
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

export async function setWalletIdentityRpcMode(mode: "zero" | "unavailable") {
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
  const state: { fixture: string; mode: string; calls: Record<string, number> } =
    await response.json();
  if (state.fixture !== "wallet-identity" || state.mode !== mode) {
    throw new Error("RPC endpoint is not the wallet identity read-only fixture");
  }
  return state;
}
