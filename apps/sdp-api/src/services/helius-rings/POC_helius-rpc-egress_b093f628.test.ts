/**
 * @title REGRESSION (SOLA9-626): Rings Solana RPC traffic must ride the guarded egress fetch
 * @notice Security statement: the production Rings gateway supplies a guarded fetch to Zolana,
 * but the pinned Zolana built its Solana RPC transport from the process-global `fetch`, so
 * `getAccountInfo`, `getLatestBlockhash`, and `getSignatureStatuses` could follow a redirect
 * into a second endpoint and accept fabricated chain state. Provisioning then returned a live
 * identity and a confirmed signature built entirely from attacker-controlled responses.
 *
 * This suite asserts the secure behavior: with a guarded fetch supplied (production), the
 * Solana RPC leg must fail closed through that guard — no request may leave through the
 * process-global transport, no fabricated record or confirmation may be accepted, and the
 * gateway must not return a provisioned identity. The development run keeps the plain
 * transport, so the local-endpoint posture is unchanged.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRingsGateway, USER_REGISTRY_PROGRAM_ID } from "@sdp/helius-rings-sdk";
import {
  type Address,
  getAddressEncoder,
  getBase58Decoder,
  getProgramDerivedAddress,
} from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "@/types/env";
import {
  derivedIdentity,
  publishedKeys,
  TEST_OWNER,
  testSignMessage,
} from "../../../../../packages/sdp-helius-rings-sdk/src/test/shielded-identity-fixtures";
import { createConfiguredRingsGateway } from "./gateway";

type CapturedGatewayConfig = Parameters<typeof createRingsGateway>[0];

const TENANT = { organizationId: "org_poc", projectId: "project_poc" };
const BLOCKHASH = getBase58Decoder().decode(new Uint8Array(32).fill(7));
const HOSTILE_SIGNATURE = getBase58Decoder().decode(new Uint8Array(64).fill(9));

function readRequest(request: IncomingMessage): Promise<{ url: string; body: string }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("error", reject);
    request.on("end", () =>
      resolve({ url: request.url ?? "", body: Buffer.concat(chunks).toString() })
    );
  });
}

function sendJson(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
): Promise<{ server: ReturnType<typeof createServer>; url: string }> {
  const server = createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error: unknown) => {
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a port");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
}

/**
 * The hostile pair: a public endpoint that passes a literal check and 307-redirects
 * into a second listener serving fabricated registry, blockhash, and confirmation data.
 */
async function hostileRpcPair() {
  const publicRequests: Array<{ url: string; body: string }> = [];
  const privateRequests: Array<{ url: string; body: string }> = [];
  let hostileMergingEnabled = false;

  const privateServer = await listen(async (request, response) => {
    const observed = await readRequest(request);
    privateRequests.push(observed);
    const payload = JSON.parse(observed.body) as { id: number; method: string };

    if (payload.method === "getAccountInfo") {
      const ownerBytes = new Uint8Array(getAddressEncoder().encode(TEST_OWNER as Address));
      const [, bump] = await getProgramDerivedAddress({
        programAddress: USER_REGISTRY_PROGRAM_ID,
        seeds: [new TextEncoder().encode("zolana/registry/v0"), ownerBytes],
      });
      const keys = await publishedKeys();
      const recordData = Uint8Array.of(
        1,
        ...ownerBytes,
        bump,
        0,
        ...keys.nullifierPublicKey,
        ...keys.viewingPublicKey,
        hostileMergingEnabled ? 1 : 0
      );
      sendJson(response, {
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          context: { slot: 777 },
          value: {
            data: [Buffer.from(recordData).toString("base64"), "base64"],
            executable: false,
            lamports: 1,
            owner: USER_REGISTRY_PROGRAM_ID,
            rentEpoch: 0,
          },
        },
      });
      return;
    }

    if (payload.method === "getLatestBlockhash") {
      sendJson(response, {
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          context: { slot: 777 },
          value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1000 },
        },
      });
      return;
    }

    if (payload.method === "getSignatureStatuses") {
      hostileMergingEnabled = true;
      sendJson(response, {
        jsonrpc: "2.0",
        id: payload.id,
        result: {
          context: { slot: 777 },
          value: [
            {
              confirmationStatus: "confirmed",
              confirmations: null,
              err: null,
              slot: 777,
            },
          ],
        },
      });
      return;
    }

    sendJson(
      response,
      { jsonrpc: "2.0", id: payload.id, error: { code: -32601, message: "unexpected method" } },
      500
    );
  });

  const publicServer = await listen(async (request, response) => {
    const observed = await readRequest(request);
    publicRequests.push(observed);
    response.writeHead(307, { location: `${privateServer.url}/rpc` });
    response.end();
  });

  return {
    publicRequests,
    privateRequests,
    async close() {
      await close(publicServer.server);
      await close(privateServer.server);
    },
    solanaRpcUrl: `${publicServer.url}/rpc?api-key=tenant-secret`,
  };
}

function productionConnection(solanaRpcUrl: string) {
  return {
    id: "hrconn_poc",
    name: "POC connection",
    solanaRpcUrl,
    indexerUrl: "https://indexer.invalid",
    proverUrl: "https://prover.invalid",
    allowInsecureHttp: false,
  };
}

function stubDependencies() {
  return {
    createGateway: (config: CapturedGatewayConfig) => createRingsGateway(config),
    signMessage: async ({ messageBase64, owner }: { messageBase64: string; owner: string }) =>
      testSignMessage(messageBase64, owner),
    signOuterTransaction: async ({ unsignedTxBase64 }: { unsignedTxBase64: string }) =>
      unsignedTxBase64,
    submitOuterTransaction: async () => HOSTILE_SIGNATURE,
  };
}

describe("Rings Solana RPC egress guard (SOLA9-626)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fails closed through the guarded fetch instead of provisioning from unguarded egress", async () => {
    const pair = await hostileRpcPair();
    const globalFetch = vi.spyOn(globalThis, "fetch");

    let captured: CapturedGatewayConfig | undefined;
    const dependencies = {
      ...stubDependencies(),
      createGateway: (config: CapturedGatewayConfig) => {
        captured = config;
        return createRingsGateway(config);
      },
    };

    try {
      const gateway = createConfiguredRingsGateway(
        { ENVIRONMENT: "production" } as Env,
        TENANT,
        productionConnection(pair.solanaRpcUrl),
        dependencies
      );

      // The gateway still supplies a guarded fetch, and that guard refuses the
      // connection's plaintext, unapproved RPC URL outright.
      expect(captured?.fetch).toBeTypeOf("function");
      await expect(
        captured?.fetch?.(pair.solanaRpcUrl, {
          method: "POST",
          headers: {},
          body: "{}",
        })
      ).rejects.toMatchObject({ name: "EgressBlockedError" });

      // The exploit: an unauthenticated attacker could not reach these servers,
      // but an authenticated project member's provisioning leg could. The RPC
      // leg must fail closed through the same guard, leaving no fabricated
      // identity and no request on either the redirecting or the hostile server.
      await expect(
        gateway.provisionIdentity({
          walletId: "hrw_poc",
          sdpAddress: TEST_OWNER,
        })
      ).rejects.toBeInstanceOf(Error);

      expect(globalFetch).not.toHaveBeenCalled();
      expect(pair.publicRequests).toEqual([]);
      expect(pair.privateRequests).toEqual([]);
    } finally {
      await pair.close();
    }
  }, 30_000);

  it("keeps the plain development transport for local endpoints", async () => {
    const pair = await hostileRpcPair();

    try {
      const gateway = createConfiguredRingsGateway(
        { ENVIRONMENT: "development" } as Env,
        TENANT,
        productionConnection(pair.solanaRpcUrl),
        stubDependencies()
      );

      const expectedIdentity = await derivedIdentity();
      // Development legitimately resolves to loopback without the guard, so the
      // provisioning flow itself must keep working end to end there.
      const provisioned = await gateway.provisionIdentity({
        walletId: "hrw_dev",
        sdpAddress: TEST_OWNER,
      });

      expect(provisioned).toMatchObject({
        identity: { owner: TEST_OWNER, shieldedAddress: expectedIdentity },
        materialTag: "live",
        registrationSignatures: [HOSTILE_SIGNATURE],
      });
      expect(pair.publicRequests.length).toBeGreaterThanOrEqual(3);
      expect(pair.privateRequests.length).toBe(pair.publicRequests.length);
    } finally {
      await pair.close();
    }
  }, 30_000);
});
