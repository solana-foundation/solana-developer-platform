/**
 * Regression coverage for SOLA9-542: a closed owner-derived Hastra redemption
 * PDA can be re-occupied by a public System transfer of rent dust. The
 * reconciler must treat that provably non-Hastra occupant as
 * `closedOrUnknown` and still search finalized history for the authenticated
 * `redemptionFulfilled`/`redemptionCancelled` event, instead of failing the
 * provider read with PROGRAM_MISMATCH before any history lookup.
 *
 * The local HTTP endpoint is a controlled Solana JSON-RPC boundary serving
 * real account bytes and lifecycle logs to the production client through the
 * real execution registry; no adapter, provider, or reconciler method is
 * mocked. A Hastra-owned occupant that cannot be decoded must still fail
 * closed.
 */

import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { wellKnownMint } from "@sdp/types";
import { HASTRA_DEPLOYMENTS, type HastraDeployment } from "@sdp/types/hastra-programs";
import {
  address,
  generateKeyPairSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { EarnVaultWithdrawalRequestRow } from "@/db/repositories/earn-vault-withdrawal-requests.repository";
import type { Env } from "@/types/env";
import { resetClusterEndpointProofs } from "./execution-registry";
import { reconcileParRequest } from "./vault-queued-withdrawal-reconciliation.service";

const configuredDeployment = HASTRA_DEPLOYMENTS["mainnet-beta"];
if (!configuredDeployment) throw new Error("test premise: Hastra mainnet deployment is configured");
const deployment: HastraDeployment = configuredDeployment;
const configuredUsdc = wellKnownMint("USDC", "mainnet-beta");
if (!configuredUsdc) throw new Error("test premise: mainnet USDC is configured");
const usdc: string = configuredUsdc;

const OWNER = "C4XGF8r1gQP7p2PeKcRAFNwGAU1gCxiinRufqddY1m98";
const PAYER = "9jQqxu5N6bV1qkh1Yv5F6zSMDNFCV2eqRV8HqvcHhk9V";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";
const encodeAddress = getAddressEncoder();
const utf8 = new TextEncoder();

function discriminator(namespace: "account" | "event", name: string): Buffer {
  return createHash("sha256").update(`${namespace}:${name}`).digest().subarray(0, 8);
}
function key(value: string): Uint8Array {
  return new Uint8Array(encodeAddress.encode(address(value)));
}
async function pda(program: string, ...seeds: (string | Uint8Array)[]): Promise<[string, number]> {
  const [derived, bump] = await getProgramDerivedAddress({
    programAddress: address(program),
    seeds: seeds.map((seed) => (typeof seed === "string" ? utf8.encode(seed) : seed)),
  });
  return [derived, bump];
}
function u32(value: number): Buffer {
  const data = Buffer.alloc(4);
  data.writeUInt32LE(value);
  return data;
}
function u64(value: bigint): Buffer {
  const data = Buffer.alloc(8);
  data.writeBigUInt64LE(value);
  return data;
}
function i64(value: bigint): Buffer {
  const data = Buffer.alloc(8);
  data.writeBigInt64LE(value);
  return data;
}
function i128(value: bigint): Buffer {
  const data = Buffer.alloc(16);
  data.writeBigUInt64LE(value & ((1n << 64n) - 1n), 0);
  data.writeBigUInt64LE(value >> 64n, 8);
  return data;
}
function tokenAccountData(mint: string, owner: string, amount: bigint): Buffer {
  const data = Buffer.alloc(165);
  Buffer.from(key(mint)).copy(data, 0);
  Buffer.from(key(owner)).copy(data, 32);
  data.writeBigUInt64LE(amount, 64);
  data[108] = 1;
  return data;
}
function mintData(authority: string | null, supply = 0n): Buffer {
  const data = Buffer.alloc(82);
  if (authority) {
    data.writeUInt32LE(1, 0);
    Buffer.from(key(authority)).copy(data, 4);
  }
  data.writeBigUInt64LE(supply, 36);
  data[44] = 6;
  data[45] = 1;
  return data;
}

interface FixtureAccount {
  data: Buffer;
  owner: string;
  executable?: boolean;
}
function accountWire(account: FixtureAccount | undefined): unknown {
  if (!account) return null;
  return {
    data: [account.data.toString("base64"), "base64"],
    executable: account.executable ?? false,
    lamports: 1,
    owner: account.owner,
  };
}

type RequestOccupant =
  | { kind: "absent" }
  | { kind: "system-dust" }
  | { kind: "hastra-corrupt" }
  | { kind: "live" };

async function fixtureAccounts(): Promise<{
  accounts: Map<string, FixtureAccount>;
  requestAddress: string;
  requestBump: number;
}> {
  const mintProgram = deployment.vaultMintProgramAddress;
  const stakeProgram = deployment.vaultStakeProgramAddress;
  const [requestAddress, requestBump] = await pda(mintProgram, "redemption_request", key(OWNER));
  const [mintConfig, mintConfigBump] = await pda(mintProgram, "config");
  const [, mintVaultConfigBump] = await pda(
    mintProgram,
    "vault_token_account_config",
    key(mintConfig)
  );
  const [stakeConfig, stakeConfigBump] = await pda(stakeProgram, "stake_config");
  const [, stakeVaultConfigBump] = await pda(
    stakeProgram,
    "stake_vault_token_account_config",
    key(stakeConfig)
  );
  const [, priceBump] = await pda(stakeProgram, "stake_price_config", key(stakeConfig));
  const depositVault = (await pda(mintProgram, "fixture_deposit_vault"))[0];
  const redeemVault = (await pda(mintProgram, "fixture_redeem_vault"))[0];
  const stakeVault = (await pda(stakeProgram, "fixture_stake_vault"))[0];
  const addresses = {
    mintAuthority: (await pda(mintProgram, "mint_authority"))[0],
    redeemVaultAuthority: (await pda(mintProgram, "redeem_vault_authority"))[0],
    stakeMintAuthority: (await pda(stakeProgram, "mint_authority"))[0],
    stakeVaultAuthority: (await pda(stakeProgram, "vault_authority"))[0],
  };
  const mintVaultTokenAccountConfig = (
    await pda(mintProgram, "vault_token_account_config", key(mintConfig))
  )[0];
  const stakeVaultTokenAccountConfig = (
    await pda(stakeProgram, "stake_vault_token_account_config", key(stakeConfig))
  )[0];
  const stakePriceConfig = (await pda(stakeProgram, "stake_price_config", key(stakeConfig)))[0];
  const accounts = new Map<string, FixtureAccount>([
    [mintProgram, { data: Buffer.alloc(0), executable: true, owner: LOADER }],
    [stakeProgram, { data: Buffer.alloc(0), executable: true, owner: LOADER }],
    [
      mintConfig,
      {
        data: Buffer.concat([
          discriminator("account", "Config"),
          Buffer.from(key(usdc)),
          Buffer.from(key(deployment.wYldsMint)),
          u32(0),
          u32(0),
          Buffer.from(key(PAYER)),
          Buffer.from(key(redeemVault)),
          Buffer.from([mintConfigBump, 0]),
          Buffer.from(key(stakeProgram)),
        ]),
        owner: mintProgram,
      },
    ],
    [
      mintVaultTokenAccountConfig,
      {
        data: Buffer.concat([
          discriminator("account", "VaultTokenAccountConfig"),
          Buffer.from(key(depositVault)),
          Buffer.from([mintVaultConfigBump]),
        ]),
        owner: mintProgram,
      },
    ],
    [
      stakeConfig,
      {
        data: Buffer.concat([
          discriminator("account", "StakeConfig"),
          Buffer.from(key(deployment.wYldsMint)),
          Buffer.from(key(deployment.primeMint)),
          i64(0n),
          u32(0),
          u32(0),
          Buffer.from([stakeConfigBump, 0]),
        ]),
        owner: stakeProgram,
      },
    ],
    [
      stakeVaultTokenAccountConfig,
      {
        data: Buffer.concat([
          discriminator("account", "StakeVaultTokenAccountConfig"),
          Buffer.from(key(stakeVault)),
          Buffer.from(key(addresses.stakeVaultAuthority)),
          Buffer.from([stakeVaultConfigBump]),
        ]),
        owner: stakeProgram,
      },
    ],
    [
      stakePriceConfig,
      {
        data: Buffer.concat([
          discriminator("account", "StakePriceConfig"),
          Buffer.from(key("B8FDo5EGA2hZ7YMugcw8wPHUYDBQJfNkEYpduXFLHfdZ")),
          Buffer.from(key(PAYER)),
          Buffer.from(key(OWNER)),
          Buffer.alloc(32, 7),
          i128(1_250_000_000n),
          u64(1_000_000_000n),
          i64(BigInt(Math.floor(Date.now() / 1_000))),
          i64(3_600n),
          Buffer.from([priceBump]),
        ]),
        owner: stakeProgram,
      },
    ],
    [usdc, { data: mintData(null), owner: TOKEN_PROGRAM }],
    [
      deployment.wYldsMint,
      { data: mintData(addresses.mintAuthority, 10_000_000_000n), owner: TOKEN_PROGRAM },
    ],
    [
      deployment.primeMint,
      { data: mintData(addresses.stakeMintAuthority, 8_000_000_000n), owner: TOKEN_PROGRAM },
    ],
    [depositVault, { data: tokenAccountData(usdc, PAYER, 10_000_000_000n), owner: TOKEN_PROGRAM }],
    [
      redeemVault,
      {
        data: tokenAccountData(usdc, addresses.redeemVaultAuthority, 10_000_000_000n),
        owner: TOKEN_PROGRAM,
      },
    ],
    [
      stakeVault,
      {
        data: tokenAccountData(
          deployment.wYldsMint,
          addresses.stakeVaultAuthority,
          10_000_000_000n
        ),
        owner: TOKEN_PROGRAM,
      },
    ],
  ]);
  return { accounts, requestAddress, requestBump };
}

function closingLog(kind: "fulfilled" | "cancelled"): string[] {
  const data =
    kind === "fulfilled"
      ? Buffer.concat([
          discriminator("event", "RedeemCompleted"),
          Buffer.from(key(OWNER)),
          Buffer.from(key(PAYER)),
          u64(2_000_000_000n),
          Buffer.from(key(deployment.wYldsMint)),
          Buffer.from(key(usdc)),
        ])
      : Buffer.concat([
          discriminator("event", "RedemptionCancelled"),
          Buffer.from(key(OWNER)),
          u64(2_000_000_000n),
          Buffer.from(key(deployment.wYldsMint)),
          Buffer.from(key(usdc)),
        ]);
  return [
    `Program ${deployment.vaultMintProgramAddress} invoke [1]`,
    `Program data: ${data.toString("base64")}`,
    `Program ${deployment.vaultMintProgramAddress} success`,
  ];
}

function liveRequestAccount(bump: number): FixtureAccount {
  return {
    data: Buffer.concat([
      discriminator("account", "RedemptionRequest"),
      Buffer.from(key(OWNER)),
      u64(2_000_000_000n),
      Buffer.from(key(deployment.wYldsMint)),
      Buffer.from([bump]),
    ]),
    owner: deployment.vaultMintProgramAddress,
  };
}

interface RpcHarness {
  readonly url: string;
  readonly calls: string[];
  requestOccupant: RequestOccupant;
  closing: "fulfilled" | "cancelled";
  close(): Promise<void>;
}

async function startRpcHarness(state: {
  accounts: Map<string, FixtureAccount>;
  requestAddress: string;
  requestBump: number;
}): Promise<RpcHarness> {
  const calls: string[] = [];
  let requestOccupant: RequestOccupant = { kind: "absent" };
  let closing: RpcHarness["closing"] = "fulfilled";
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      id: number;
      method: string;
      params: unknown[];
    };
    calls.push(body.method);
    const result = (() => {
      if (body.method === "getGenesisHash") {
        return "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
      }
      if (body.method === "getMultipleAccounts") {
        return {
          value: (body.params[0] as string[]).map((value) =>
            accountWire(state.accounts.get(value))
          ),
        };
      }
      if (body.method === "getAccountInfo") {
        const value = body.params[0] as string;
        if (value === state.requestAddress) {
          if (requestOccupant.kind === "system-dust") {
            return { value: accountWire({ data: Buffer.alloc(0), owner: SYSTEM_PROGRAM }) };
          }
          if (requestOccupant.kind === "hastra-corrupt") {
            return {
              value: accountWire({
                data: Buffer.alloc(1),
                owner: deployment.vaultMintProgramAddress,
              }),
            };
          }
          if (requestOccupant.kind === "live") {
            return { value: accountWire(liveRequestAccount(state.requestBump)) };
          }
          return { value: null };
        }
        return { value: accountWire(state.accounts.get(value)) };
      }
      if (body.method === "getSignaturesForAddress") {
        // A base58-safe stand-in signature: the real kit client parses the wire value.
        return [{ signature: "1".repeat(87), slot: 42, err: null }];
      }
      if (body.method === "getTransaction") {
        return {
          blockTime: 1_800_000_200,
          meta: {
            err: null,
            logMessages: closingLog(closing),
          },
        };
      }
      throw new Error(`unexpected RPC method ${body.method}`);
    })();
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("test premise: RPC server did not bind");
  return {
    get requestOccupant() {
      return requestOccupant;
    },
    set requestOccupant(value: RequestOccupant) {
      requestOccupant = value;
    },
    get closing() {
      return closing;
    },
    set closing(value: RpcHarness["closing"]) {
      closing = value;
    },
    calls,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      ),
    url: `http://127.0.0.1:${bound.port}`,
  };
}

function requestRow(requestAddress: string): EarnVaultWithdrawalRequestRow {
  return {
    id: "dust-regression-withdrawal",
    mechanism: "operator_redemption",
    provider: "hastra",
    environment: "production",
    organization_id: "regression-org",
    request_address: requestAddress,
    creation_signature: "request-signature",
    vault_address: deployment.primeMint,
    owner_address: OWNER,
    intermediate_mint: deployment.wYldsMint,
    intermediate_amount: "2000",
    share_decimals: 6,
    asset_decimals: 6,
    status: "pending",
    maturity_timestamp: null,
    next_check_at: null,
  } as EarnVaultWithdrawalRequestRow;
}

function env(rpcUrl: string): Env {
  return {
    API_VERSION: "test",
    ENVIRONMENT: "production",
    SDP_DEPLOYMENT_MODE: "self_hosted",
    SOLANA_MAINNET_RPC_URL: rpcUrl,
    SOLANA_NETWORK: "mainnet-beta",
  } as Env;
}

function recordingLedger(): {
  advances: Record<string, unknown>[];
  ledger: never;
} {
  const advances: Record<string, unknown>[] = [];
  return {
    advances,
    ledger: {
      advanceRequest: vi.fn(async (input: Record<string, unknown>) => {
        advances.push(input);
        return null;
      }),
    } as never,
  };
}

describe("post-close Hastra PDA dust reconciliation", () => {
  let state: Awaited<ReturnType<typeof fixtureAccounts>>;
  let rpc: RpcHarness;

  beforeAll(async () => {
    state = await fixtureAccounts();
    rpc = await startRpcHarness(state);
  });
  afterAll(async () => {
    await rpc.close();
  });

  it("projects a real fulfillment when the request PDA is absent", async () => {
    resetClusterEndpointProofs();
    const { advances, ledger } = recordingLedger();
    rpc.requestOccupant = { kind: "absent" };
    rpc.closing = "fulfilled";
    rpc.calls.length = 0;

    await expect(
      reconcileParRequest(env(rpc.url), ledger, requestRow(state.requestAddress))
    ).resolves.toBe("advanced");
    expect(rpc.calls).toContain("getSignaturesForAddress");
    expect(advances.at(-1)).toMatchObject({
      assetsPaid: "2000",
      closingSignature: "1".repeat(87),
      toStatus: "fulfilled",
    });
  });

  it("still projects fulfillment after the closed PDA is dusted with a System account", async () => {
    resetClusterEndpointProofs();
    // One plain System transfer from any attacker wallet re-occupies the
    // closed request PDA: the destination becomes a zero-data System-owned
    // account, which is exactly the state the fixture serves next.
    const attacker = await generateKeyPairSigner();
    const dustTransfer = getTransferSolInstruction({
      source: attacker,
      destination: address(state.requestAddress),
      amount: 1n,
    });
    expect(dustTransfer.programAddress).toBe(SYSTEM_PROGRAM);
    expect(dustTransfer.accounts[1]?.address).toBe(state.requestAddress);

    const { advances, ledger } = recordingLedger();
    rpc.requestOccupant = { kind: "system-dust" };
    rpc.closing = "fulfilled";
    rpc.calls.length = 0;

    await expect(
      reconcileParRequest(env(rpc.url), ledger, requestRow(state.requestAddress))
    ).resolves.toBe("advanced");
    expect(rpc.calls).toContain("getAccountInfo");
    expect(rpc.calls).toContain("getSignaturesForAddress");
    expect(advances.at(-1)).toMatchObject({
      assetsPaid: "2000",
      closingSignature: "1".repeat(87),
      toStatus: "fulfilled",
    });
  });

  it("still projects cancellation after the closed PDA is dusted with a System account", async () => {
    resetClusterEndpointProofs();
    const { advances, ledger } = recordingLedger();
    rpc.requestOccupant = { kind: "system-dust" };
    rpc.closing = "cancelled";
    rpc.calls.length = 0;

    await expect(
      reconcileParRequest(env(rpc.url), ledger, requestRow(state.requestAddress))
    ).resolves.toBe("advanced");
    expect(rpc.calls).toContain("getSignaturesForAddress");
    expect(advances.at(-1)).toMatchObject({
      closingSignature: "1".repeat(87),
      toStatus: "cancelled",
    });
  });

  it("keeps failing closed when a Hastra-owned occupant cannot be decoded", async () => {
    resetClusterEndpointProofs();
    const { advances, ledger } = recordingLedger();
    rpc.requestOccupant = { kind: "hastra-corrupt" };
    rpc.calls.length = 0;

    await expect(
      reconcileParRequest(env(rpc.url), ledger, requestRow(state.requestAddress))
    ).rejects.toMatchObject({ code: "PROGRAM_MISMATCH" });
    expect(rpc.calls).not.toContain("getSignaturesForAddress");
    expect(advances).toHaveLength(0);
  });

  it("keeps reporting a live request as pending while the PDA holds a decodable request", async () => {
    resetClusterEndpointProofs();
    const { advances, ledger } = recordingLedger();
    rpc.requestOccupant = { kind: "live" };
    rpc.calls.length = 0;

    await expect(
      reconcileParRequest(env(rpc.url), ledger, requestRow(state.requestAddress))
    ).resolves.toBe("unchanged");
    expect(rpc.calls).not.toContain("getSignaturesForAddress");
    expect(advances.at(-1)).toMatchObject({ toStatus: "pending", lastIndexError: null });
  });
});
