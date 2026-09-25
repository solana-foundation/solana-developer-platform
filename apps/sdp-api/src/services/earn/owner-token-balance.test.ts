import { createServer, type Server } from "node:http";
import { GENESIS_HASH_BY_CLUSTER } from "@sdp/types";
import { address, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { resetClusterEndpointProofs } from "./execution-registry";
import { ownerHoldsMintAccount, readOwnerMintBalance } from "./owner-token-balance";

const OWNER = "3nMFwZXwY1s1M5s8vYAHqd4wGs4iSxXE4LRoUMMYqEgF";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
/** An address that is never derived or referenced by the requests under test. */
const SOME_ATA = "HQ2wYZz3SQQCHkhQMQpjTLczAQ7Wr4aN6n3fGWWiuQ7f";

/**
 * The filter object of a JSON-RPC token-accounts request: kit sends positional
 * params, so the filter sits at `params[1]`.
 */
function scanFilter(params: unknown): { programId?: string } {
  const filter = Array.isArray(params) ? params[1] : params;
  return (filter ?? {}) as { programId?: string };
}

const servers: Server[] = [];
const rpcRequestSchema = z.object({
  id: z.union([z.string(), z.number()]),
  method: z.string(),
  params: z.unknown().optional(),
});

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type RpcHandler = (request: { method: string; params: unknown }) => JsonValue;

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
      complete: true,
    });
  });

  it("reports an empty account list as an incomplete zero balance", async () => {
    // SOLA9-675: `value: []` is indistinguishable from an incomplete index, so
    // the zero is returned but flagged: callers must not treat it as
    // conclusive without independent account evidence.
    const rpcUrl = await serveRpcResponse({ context: { slot: 1 }, value: [] });

    await expect(readBalance(rpcUrl)).resolves.toEqual({
      atoms: 0n,
      decimals: null,
      complete: false,
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

describe("ownerHoldsMintAccount", () => {
  it("finds a held token account the program-filtered scan indexes", async () => {
    // The incomplete-index scenario: the mint-filtered read came back empty,
    // but the token program's own index still shows the owner's account.
    const requests: string[] = [];
    const rpcUrl = await serveRpcMethods(({ method, params }) => {
      requests.push(`${method}:${JSON.stringify(params)}`);
      return method === "getMultipleAccounts"
        ? { context: { slot: 1 }, value: [null, null] }
        : scanFilter(params).programId === TOKEN_2022_PROGRAM
          ? { context: { slot: 1 }, value: [tokenAccount("24800000")] }
          : { context: { slot: 1 }, value: [] };
    });

    await expect(holdsAccount(rpcUrl)).resolves.toBe(true);

    // The scans went out by token program, not by mint, and cover both
    // programs: an index that drops the mint-filtered answer cannot drop
    // these too.
    expect(requests.filter((request) => request.startsWith("getTokenAccountsByOwner"))).toEqual([
      expect.stringContaining(TOKEN_PROGRAM),
      expect.stringContaining(TOKEN_2022_PROGRAM),
    ]);
  });

  it("finds a held account through a derived ATA no index can hide", async () => {
    const [splAta, token2022Ata] = await Promise.all(
      [TOKEN_PROGRAM, TOKEN_2022_PROGRAM].map(async (tokenProgram) => {
        const [associated] = await getProgramDerivedAddress({
          programAddress: address(ATA_PROGRAM),
          seeds: [
            getAddressEncoder().encode(address(OWNER)),
            getAddressEncoder().encode(address(tokenProgram)),
            getAddressEncoder().encode(address(USDC)),
          ],
        });
        return associated;
      })
    );
    const requestedAddresses: string[][] = [];
    const rpcUrl = await serveRpcMethods(({ method, params }) => {
      if (method === "getMultipleAccounts") {
        requestedAddresses.push(Array.isArray(params) ? (params[0] as string[]) : []);
        return { context: { slot: 1 }, value: [existingAccount(), null] };
      }
      return { context: { slot: 1 }, value: [] };
    });

    await expect(holdsAccount(rpcUrl)).resolves.toBe(true);

    // Raw chain state, not an index: the check probes the owner's own derived
    // associated token accounts for the mint, on chain.
    expect(requestedAddresses).toEqual([[splAta, token2022Ata]]);
  });

  it("corroborates a zero when both scans are empty and no derived ATA exists", async () => {
    const rpcUrl = await serveRpcMethods(({ method }) =>
      method === "getMultipleAccounts"
        ? { context: { slot: 1 }, value: [null, null] }
        : { context: { slot: 1 }, value: [] }
    );

    await expect(holdsAccount(rpcUrl)).resolves.toBe(false);
  });

  it("fails closed when a program-filtered response is malformed", async () => {
    const rpcUrl = await serveRpcMethods(
      ({ method }): JsonValue =>
        method === "getMultipleAccounts"
          ? { context: { slot: 1 }, value: [null, null] }
          : { context: { slot: 1 } }
    );

    await expect(holdsAccount(rpcUrl)).rejects.toThrow(/token-account RPC response/i);
  });

  it("fails closed when a scanned account is out of scope", async () => {
    const rpcUrl = await serveRpcMethods(({ method, params }) =>
      method === "getMultipleAccounts"
        ? { context: { slot: 1 }, value: [null, null] }
        : scanFilter(params).programId === TOKEN_PROGRAM
          ? {
              context: { slot: 1 },
              value: [tokenAccount("24800000", 6, { owner: SOME_ATA })],
            }
          : { context: { slot: 1 }, value: [] }
    );

    await expect(holdsAccount(rpcUrl)).rejects.toThrow(/out of scope/i);
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

function holdsAccount(rpcUrl: string) {
  return ownerHoldsMintAccount(
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
  return serveRpcMethods(({ method }) =>
    method === "getGenesisHash" ? GENESIS_HASH_BY_CLUSTER.devnet : tokenAccountsResult
  );
}

function existingAccount(): JsonValue {
  return {
    executable: false,
    lamports: 2_039_280,
    owner: TOKEN_PROGRAM,
    rentEpoch: 0,
    space: 165,
    data: ["", "base64"],
  };
}

/** Serves one JSON-RPC endpoint where each method is answered by its handler. */
async function serveRpcMethods(handler: RpcHandler): Promise<string> {
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = rpcRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const result =
      body.method === "getGenesisHash"
        ? GENESIS_HASH_BY_CLUSTER.devnet
        : handler({ method: body.method, params: body.params });
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
