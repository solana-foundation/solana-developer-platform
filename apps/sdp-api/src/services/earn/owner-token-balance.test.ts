import { createServer, type Server } from "node:http";
import { resetClusterEndpointProofs } from "@sdp/rpc/solana";
import { GENESIS_HASH_BY_CLUSTER } from "@sdp/types";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { readOwnerMintBalance } from "./owner-token-balance";

const OWNER = "3nMFwZXwY1s1M5s8vYAHqd4wGs4iSxXE4LRoUMMYqEgF";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const servers: Server[] = [];
const rpcRequestSchema = z.object({
  id: z.union([z.string(), z.number()]),
  method: z.string(),
});

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

afterEach(async () => {
  resetClusterEndpointProofs();
  await Promise.all(servers.splice(0).map((server) => closeServer(server)));
});

describe("readOwnerMintBalance", () => {
  it("sums every matching token account in exact atoms", async () => {
    const rpcUrl = await serveRpcResponse({
      context: { slot: 1 },
      value: [tokenAccount("9007199254740993"), tokenAccount("9007199254740995")],
    });

    await expect(readBalance(rpcUrl)).resolves.toEqual({
      atoms: 18_014_398_509_481_988n,
      decimals: 6,
    });
  });

  it("accepts an empty account list as an exact zero balance", async () => {
    const rpcUrl = await serveRpcResponse({ context: { slot: 1 }, value: [] });

    await expect(readBalance(rpcUrl)).resolves.toEqual({
      atoms: 0n,
      decimals: null,
    });
  });

  it("fails closed when a mint-filtered RPC response omits its account list", async () => {
    const rpcUrl = await serveRpcResponse({ context: { slot: 1 } });

    await expect(readBalance(rpcUrl)).rejects.toThrow(/token-account RPC response/i);
  });

  it.each([
    ["missing amount", tokenAccount(null)],
    ["numeric amount", tokenAccount(12)],
    ["fractional amount", tokenAccount("1.5")],
    ["non-integer decimals", tokenAccount("1", 6.5)],
  ])("fails closed on a %s", async (_label, account) => {
    const rpcUrl = await serveRpcResponse({
      context: { slot: 1 },
      value: [account],
    });

    await expect(readBalance(rpcUrl)).rejects.toThrow(/token-account RPC response/i);
  });

  it("fails closed when matching accounts report inconsistent decimals", async () => {
    const rpcUrl = await serveRpcResponse({
      context: { slot: 1 },
      value: [tokenAccount("1", 6), tokenAccount("1", 9)],
    });

    await expect(readBalance(rpcUrl)).rejects.toThrow(/inconsistent decimals/i);
  });

  it.each([
    ["mint", tokenAccount("1", 6, { mint: OWNER })],
    ["owner", tokenAccount("1", 6, { owner: USDC })],
  ])("fails closed when the RPC returns an out-of-scope %s", async (_label, account) => {
    const rpcUrl = await serveRpcResponse({
      context: { slot: 1 },
      value: [account],
    });

    await expect(readBalance(rpcUrl)).rejects.toThrow(/out of scope/i);
  });
});

function readBalance(rpcUrl: string) {
  return readOwnerMintBalance(
    {
      ENVIRONMENT: "development",
      API_VERSION: "v1",
      SOLANA_NETWORK: "devnet",
      SOLANA_DEVNET_RPC_URL: rpcUrl,
    },
    "sandbox",
    OWNER,
    USDC
  );
}

function tokenAccount(
  amount: JsonValue,
  decimals = 6,
  scope: { mint?: string; owner?: string } = {}
): JsonValue {
  return {
    account: {
      data: {
        parsed: {
          type: "account",
          info: {
            mint: scope.mint ?? USDC,
            owner: scope.owner ?? OWNER,
            tokenAmount: { amount, decimals },
          },
        },
      },
    },
  };
}

async function serveRpcResponse(tokenAccountsResult: JsonValue): Promise<string> {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = rpcRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const result =
      body.method === "getGenesisHash" ? GENESIS_HASH_BY_CLUSTER.devnet : tokenAccountsResult;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const listeningAddress = server.address();
  if (listeningAddress === null || typeof listeningAddress === "string") {
    throw new Error("Test RPC server did not bind a TCP port");
  }
  return `http://127.0.0.1:${listeningAddress.port}`;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
}
