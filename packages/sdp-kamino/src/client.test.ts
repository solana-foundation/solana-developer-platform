import {
  supportsPortfolioWallets,
  supportsVaultDepositQuote,
  supportsVaultDirect,
  supportsVaultWithdraw,
  supportsVaultWithdrawQuote,
} from "@sdp/earn/capabilities";
import { createClusterBoundedRpc, createClusterReadRpc } from "@sdp/rpc/factory";
import { runInClusterScope } from "@sdp/rpc/scope";
import { GENESIS_HASH_BY_CLUSTER } from "@sdp/types";
import { address } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertNotPortfolioProvider,
  KAMINO_RPC_REQUEST_TIMEOUT_MS,
  KaminoVaultDirectClient,
  type KaminoVaultOperationRunner,
  toEarnVaultTransactionPlan,
} from "./client";
import type { KaminoInstructionPlan, KaminoPosition, KaminoRuntime } from "./types";

const DEPOSIT_TOKEN_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SHARE_MINT = "So11111111111111111111111111111111111111112";
const DEVNET_RPC_URL = "https://devnet.kamino-client.test";
const SANDBOX_SCOPE: Parameters<typeof runInClusterScope>[0] = {
  projectId: "proj_kamino_client",
  environment: "sandbox",
};

const mocks = vi.hoisted(() => ({
  buildKaminoDepositPlan: vi.fn(),
  buildKaminoWithdrawPlan: vi.fn(),
  discoverKaminoPositionVaults: vi.fn(),
  quoteKaminoDeposit: vi.fn(),
  quoteKaminoWithdraw: vi.fn(),
  readKaminoPositions: vi.fn(),
}));

vi.mock("./sdk", () => ({
  buildKaminoDepositPlan: mocks.buildKaminoDepositPlan,
  buildKaminoWithdrawPlan: mocks.buildKaminoWithdrawPlan,
  discoverKaminoPositionVaults: mocks.discoverKaminoPositionVaults,
  quoteKaminoDeposit: mocks.quoteKaminoDeposit,
  quoteKaminoWithdraw: mocks.quoteKaminoWithdraw,
  readKaminoPositions: mocks.readKaminoPositions,
}));

function position(
  runtime: KaminoRuntime,
  vault: string,
  owner: string,
  shares: string
): KaminoPosition {
  return {
    vault: address(vault),
    owner: address(owner),
    cluster: runtime.cluster,
    shares,
    withdrawableShares: shares,
    tokenMint: address(DEPOSIT_TOKEN_MINT),
    sharesMint: address(SHARE_MINT),
  };
}

function stubChainSlot(answerSlot: () => number): string[] {
  const methods: string[] = [];
  vi.stubGlobal("fetch", async (_input: string, init: { body: string }) => {
    const request: unknown = JSON.parse(init.body);
    if (
      typeof request !== "object" ||
      request === null ||
      !("id" in request) ||
      !("method" in request) ||
      typeof request.method !== "string"
    ) {
      throw new Error("Expected a JSON-RPC request");
    }
    if (request.method === "getGenesisHash") {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: request.id, result: GENESIS_HASH_BY_CLUSTER.devnet })
      );
    }
    methods.push(request.method);
    if (request.method !== "getSlot") throw new Error(`Unexpected ${request.method}`);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: answerSlot() }));
  });
  return methods;
}

function sandboxRuntime(): KaminoRuntime {
  return runInClusterScope(SANDBOX_SCOPE, () => ({
    cluster: "devnet",
    rpc: createClusterBoundedRpc({ timeoutMs: KAMINO_RPC_REQUEST_TIMEOUT_MS }),
    readRpc: createClusterReadRpc({ timeoutMs: KAMINO_RPC_REQUEST_TIMEOUT_MS }),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SOLANA_RPC_TRITON_DEVNET_API_KEY_URL", DEVNET_RPC_URL);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const runOperation: KaminoVaultOperationRunner = (_label, operation) =>
  runInClusterScope(SANDBOX_SCOPE, () => operation(() => undefined));
const client = new KaminoVaultDirectClient(runOperation);

describe("KaminoVaultDirectClient capabilities", () => {
  it("reports the vault-direct capability", () => {
    expect(supportsVaultDirect(client)).toBe(true);
  });

  /** The implemented capability lets the exit route narrow onto this client. */
  it("reports the withdraw capability", () => {
    expect(supportsVaultWithdraw(client)).toBe(true);
    expect(typeof client.buildVaultWithdrawal).toBe("function");
  });

  it("refuses an unsupported withdrawal floor before any chain read or build", async () => {
    const methods = stubChainSlot(() => 1);

    await expect(
      client.buildVaultWithdrawal(
        { env: {}, environment: "production" },
        {
          providerReference: "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx",
          owner: "11111111111111111111111111111112",
          shares: "2",
          minAmountOut: "1.99",
        }
      )
    ).rejects.toMatchObject({ code: "WITHDRAW_REFUSED" });
    expect(methods).toEqual([]);
    expect(mocks.buildKaminoWithdrawPlan).not.toHaveBeenCalled();
  });

  it.each([undefined, "So11111111111111111111111111111111111111112", "invalid-address"])(
    "maps the withdrawal plan without parsing or forwarding refund hint %s",
    async (rentRefundTo) => {
      const slot = 456n;
      const methods = stubChainSlot(() => Number(slot));

      const vault = "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx";
      const owner = "11111111111111111111111111111112";
      const builtPlan: KaminoInstructionPlan = {
        cluster: "devnet",
        instructions: [],
        lookupTables: [address(SHARE_MINT)],
        assetIdentity: {
          depositTokenMint: address(DEPOSIT_TOKEN_MINT),
          shareMint: address(SHARE_MINT),
        },
        accepted: { shares: "2" },
      };
      mocks.buildKaminoWithdrawPlan.mockResolvedValue(builtPlan);

      const plan = await client.buildVaultWithdrawal(
        { env: {}, environment: "sandbox" },
        { providerReference: vault, owner, shares: "2", rentRefundTo }
      );

      expect(methods).toEqual(["getSlot"]);
      expect(mocks.buildKaminoWithdrawPlan).toHaveBeenCalledWith(
        sandboxRuntime(),
        expect.objectContaining({
          vault: address(vault),
          shares: "2",
          slot,
        }),
        expect.any(Function)
      );
      // The noop signer carries the custody address; the API attaches the real
      // signer at compile time by address match.
      expect(String(mocks.buildKaminoWithdrawPlan.mock.calls[0][1].owner.address)).toBe(owner);
      expect(mocks.buildKaminoWithdrawPlan.mock.calls[0][1]).not.toHaveProperty("rentRefundTo");
      expect(plan).toMatchObject({
        cluster: "devnet",
        lookupTables: [SHARE_MINT],
        accepted: { shares: "2" },
      });
    }
  );

  /** Both quote guards narrow onto this client, so the preview routes no longer 501. */
  it("reports both quote capabilities", () => {
    expect(supportsVaultDepositQuote(client)).toBe(true);
    expect(supportsVaultWithdrawQuote(client)).toBe(true);
  });

  it("prices the deposit quote against one slot and maps it to the Earn contract", async () => {
    const slot = 789n;
    const methods = stubChainSlot(() => Number(slot));
    const issues = [{ code: "DEPOSIT_CAP_EXCEEDED", message: "Cap exceeded" }];
    mocks.quoteKaminoDeposit.mockResolvedValue({ sharesOut: "0.999", shareDecimals: 6, issues });
    const vault = "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx";

    const quote = await client.quoteVaultDeposit(
      { env: {}, environment: "sandbox" },
      { providerReference: vault, amount: "1" }
    );

    expect(methods).toEqual(["getSlot"]);
    expect(mocks.quoteKaminoDeposit).toHaveBeenCalledWith(
      sandboxRuntime(),
      { vault: address(vault), amount: "1", slot },
      expect.any(Function)
    );
    expect(mocks.quoteKaminoDeposit.mock.calls[0][0].rpc).toBe(sandboxRuntime().rpc);
    expect(mocks.quoteKaminoDeposit.mock.calls[0][0].readRpc).toBe(sandboxRuntime().readRpc);
    expect(quote).toEqual({ sharesOut: "0.999", shareDecimals: 6, blockingIssues: issues });
  });

  it("prices the withdrawal quote against one slot and maps it to the Earn contract", async () => {
    const slot = 790n;
    const methods = stubChainSlot(() => Number(slot));
    const issues = [{ code: "INSUFFICIENT_WITHDRAWAL_LIQUIDITY", message: "Short" }];
    mocks.quoteKaminoWithdraw.mockResolvedValue({ assetsOut: "4.997", assetDecimals: 6, issues });
    const vault = "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx";

    const quote = await client.quoteVaultWithdrawal(
      { env: {}, environment: "sandbox" },
      { providerReference: vault, shares: "5" }
    );

    expect(methods).toEqual(["getSlot"]);
    expect(mocks.quoteKaminoWithdraw).toHaveBeenCalledWith(
      sandboxRuntime(),
      { vault: address(vault), shares: "5", slot },
      expect.any(Function)
    );
    expect(quote).toEqual({ assetsOut: "4.997", assetDecimals: 6, blockingIssues: issues });
  });

  /**
   * THE INVARIANT THAT PROTECTS CUSTOMER FUNDS.
   *
   * The portfolio capability means "SDP can give you an address to send
   * stablecoins to". Kamino has no such address — its vault is a program
   * account, and tokens sent there are DESTROYED. If this client ever answered
   * yes to both, a portfolio route could render that account as a deposit
   * target. The two capabilities must stay mutually exclusive.
   */
  it("NEVER reports the portfolio-wallet capability", () => {
    expect(supportsPortfolioWallets(client)).toBe(false);
    expect(() => assertNotPortfolioProvider(client)).not.toThrow();
  });

  it("still catalogues — the execution client is a superset, not a replacement", () => {
    expect(client.provider).toBe("kamino");
    expect(client.declaredSupport.sourceKinds).toEqual(["defi"]);
    expect(typeof client.listStrategies).toBe("function");
  });

  it("refuses a production context inside a sandbox cluster scope before any chain work", async () => {
    const methods = stubChainSlot(() => 1);
    const unscoped = new KaminoVaultDirectClient((_label, operation) => operation(() => undefined));

    await expect(
      runInClusterScope(SANDBOX_SCOPE, () =>
        unscoped.quoteVaultDeposit(
          { env: {}, environment: "production" },
          { providerReference: "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx", amount: "1" }
        )
      )
    ).rejects.toMatchObject({ name: "SdpEarnError", code: "INTERNAL_ERROR" });
    expect(methods).toEqual([]);
    expect(mocks.quoteKaminoDeposit).not.toHaveBeenCalled();
  });

  it("discovers owner-held vaults on chain without consulting the curated shelf", async () => {
    const slot = 123n;
    const methods = stubChainSlot(() => Number(slot));

    const providerReferences = ["7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx", SHARE_MINT];
    const owner = "11111111111111111111111111111112";
    mocks.discoverKaminoPositionVaults.mockResolvedValue(providerReferences.map(address));
    const listStrategies = vi.spyOn(client, "listStrategies");
    mocks.readKaminoPositions.mockImplementation(
      async (runtime: KaminoRuntime, input: { vaults: string[]; owner: string }) =>
        input.vaults.map((vault) => ({
          status: "fulfilled",
          value: position(runtime, vault, input.owner, vault === providerReferences[1] ? "0" : "1"),
        }))
    );
    const positions = await client.readVaultPositions(
      {
        environment: "sandbox",
        env: {},
      },
      {
        owner,
        providerReferences: [],
      }
    );

    expect(mocks.discoverKaminoPositionVaults).toHaveBeenCalledWith(
      sandboxRuntime(),
      address(owner),
      expect.any(Function)
    );
    expect(listStrategies).not.toHaveBeenCalled();
    expect(methods).toEqual(["getSlot"]);
    expect(positions.map((entry) => entry.providerReference)).toEqual([providerReferences[0]]);
    expect(mocks.readKaminoPositions).toHaveBeenCalledOnce();
    expect(mocks.readKaminoPositions).toHaveBeenCalledWith(
      sandboxRuntime(),
      { vaults: providerReferences, owner: address(owner), slot },
      expect.any(Function)
    );
  });

  it("returns an empty snapshot without slot or hydration reads when discovery finds no holdings", async () => {
    const methods = stubChainSlot(() => 1);
    mocks.discoverKaminoPositionVaults.mockResolvedValue([]);

    await expect(
      client.readVaultPositions(
        { env: {}, environment: "sandbox" },
        {
          owner: "11111111111111111111111111111112",
          providerReferences: [],
        }
      )
    ).resolves.toEqual([]);

    expect(mocks.discoverKaminoPositionVaults).toHaveBeenCalledOnce();
    expect(methods).toEqual([]);
    expect(mocks.readKaminoPositions).not.toHaveBeenCalled();
  });

  it("propagates on-chain discovery failures instead of reporting no holdings", async () => {
    const methods = stubChainSlot(() => 1);
    const discoveryError = new Error("program census unavailable");
    mocks.discoverKaminoPositionVaults.mockRejectedValue(discoveryError);

    await expect(
      client.readVaultPositions(
        { env: {}, environment: "sandbox" },
        {
          owner: "11111111111111111111111111111112",
          providerReferences: [],
        }
      )
    ).rejects.toBe(discoveryError);

    expect(methods).toEqual([]);
    expect(mocks.readKaminoPositions).not.toHaveBeenCalled();
  });

  it("fails the whole snapshot when any discovered vault cannot be hydrated", async () => {
    stubChainSlot(() => 123);

    const owner = "11111111111111111111111111111112";
    const providerReferences = ["7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx", SHARE_MINT];
    mocks.discoverKaminoPositionVaults.mockResolvedValue(providerReferences.map(address));
    mocks.readKaminoPositions.mockImplementation(
      async (runtime: KaminoRuntime, input: { vaults: string[]; owner: string }) =>
        input.vaults.map((vault) =>
          vault === SHARE_MINT
            ? { status: "rejected", reason: new Error("RPC unavailable") }
            : { status: "fulfilled", value: position(runtime, vault, input.owner, "1") }
        )
    );

    await expect(
      client.readVaultPositions(
        { env: {}, environment: "sandbox" },
        { owner, providerReferences: [] }
      )
    ).rejects.toMatchObject({
      code: "VAULT_UNREADABLE",
      message: expect.stringMatching(/refusing to return a partial portfolio/),
      cause: expect.objectContaining({ errors: [expect.any(Error)] }),
    });
    expect(mocks.readKaminoPositions).toHaveBeenCalledOnce();
  });

  it("reads every requested vault in one page read against one shared slot", async () => {
    const slot = 123n;
    const methods = stubChainSlot(() => Number(slot));
    mocks.readKaminoPositions.mockImplementation(
      async (runtime: KaminoRuntime, input: { vaults: string[]; owner: string }) =>
        input.vaults.map((vault) => ({
          status: "fulfilled",
          value: position(runtime, vault, input.owner, "1"),
        }))
    );

    const vault = "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx";
    const providerReferences = Array.from({ length: 9 }, () => vault);
    await expect(
      client.readVaultPositions(
        { env: {}, environment: "sandbox" },
        { owner: "11111111111111111111111111111112", providerReferences }
      )
    ).resolves.toHaveLength(9);

    expect(methods).toEqual(["getSlot"]);
    expect(mocks.discoverKaminoPositionVaults).not.toHaveBeenCalled();
    expect(mocks.readKaminoPositions).toHaveBeenCalledOnce();
    expect(mocks.readKaminoPositions.mock.calls[0]?.[1]).toMatchObject({
      vaults: providerReferences,
      slot,
    });
  });

  it("does not start the page read after the operation expires", async () => {
    let expired = false;
    const probe = new KaminoVaultDirectClient((_label, operation) =>
      runInClusterScope(SANDBOX_SCOPE, () =>
        operation(() => {
          if (expired) throw new Error("vault operation expired");
        })
      )
    );
    stubChainSlot(() => {
      expired = true;
      return 123;
    });

    await expect(
      probe.readVaultPositions(
        { env: {}, environment: "sandbox" },
        {
          owner: "11111111111111111111111111111112",
          providerReferences: ["7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx"],
        }
      )
    ).rejects.toThrow("vault operation expired");
    expect(mocks.readKaminoPositions).not.toHaveBeenCalled();
  });
});

describe("toEarnVaultTransactionPlan", () => {
  it("preserves the mint-scale amounts encoded by the SDK plan", () => {
    const plan: KaminoInstructionPlan = {
      cluster: "devnet",
      instructions: [],
      lookupTables: [],
      assetIdentity: {
        depositTokenMint: address(DEPOSIT_TOKEN_MINT),
        shareMint: address(SHARE_MINT),
      },
      accepted: { amount: "1.5", minSharesOut: "1.49" },
    };

    expect(toEarnVaultTransactionPlan(plan)).toMatchObject({
      cluster: "devnet",
      instructions: [],
      lookupTables: [],
      assetIdentity: {
        depositTokenMint: DEPOSIT_TOKEN_MINT,
        shareMint: SHARE_MINT,
      },
      accepted: { amount: "1.5", minSharesOut: "1.49" },
    });
  });
});
