import {
  supportsPortfolioWallets,
  supportsVaultDepositQuote,
  supportsVaultDirect,
  supportsVaultWithdraw,
  supportsVaultWithdrawQuote,
} from "@sdp/earn/capabilities";
import { address } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertNotPortfolioProvider,
  KaminoVaultDirectClient,
  type KaminoVaultOperationRunner,
  toEarnVaultTransactionPlan,
} from "./client";
import type { KaminoInstructionPlan, KaminoPosition, KaminoRuntime } from "./types";

const DEPOSIT_TOKEN_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SHARE_MINT = "So11111111111111111111111111111111111111112";

const mocks = vi.hoisted(() => ({
  buildKaminoDepositPlan: vi.fn(),
  buildKaminoWithdrawPlan: vi.fn(),
  createKaminoReadRpc: vi.fn(),
  createKaminoRpc: vi.fn(),
  discoverKaminoPositionVaults: vi.fn(),
  quoteKaminoDeposit: vi.fn(),
  quoteKaminoWithdraw: vi.fn(),
  readKaminoPositions: vi.fn(),
}));

vi.mock("./rpc", () => ({
  createKaminoReadRpc: mocks.createKaminoReadRpc,
  createKaminoRpc: mocks.createKaminoRpc,
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

beforeEach(() => {
  vi.clearAllMocks();
});

const runOperation: KaminoVaultOperationRunner = (_label, operation) => operation(() => undefined);
const client = new KaminoVaultDirectClient(async () => "https://example.invalid", runOperation);

describe("KaminoVaultDirectClient capabilities", () => {
  it("reports the vault-direct capability", () => {
    expect(supportsVaultDirect(client)).toBe(true);
  });

  /** The implemented capability lets the exit route narrow onto this client. */
  it("reports the withdraw capability", () => {
    expect(supportsVaultWithdraw(client)).toBe(true);
    expect(typeof client.buildVaultWithdrawal).toBe("function");
  });

  it("refuses an unsupported withdrawal floor before resolving an RPC or building", async () => {
    const resolveRpc = vi.fn(async () => "https://example.invalid");
    const probe = new KaminoVaultDirectClient(resolveRpc, runOperation);

    await expect(
      probe.buildVaultWithdrawal(
        { env: {}, environment: "production" },
        {
          providerReference: "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx",
          owner: "11111111111111111111111111111112",
          shares: "2",
          minAmountOut: "1.99",
        }
      )
    ).rejects.toMatchObject({ code: "WITHDRAW_REFUSED" });
    expect(resolveRpc).not.toHaveBeenCalled();
    expect(mocks.buildKaminoWithdrawPlan).not.toHaveBeenCalled();
  });

  it.each([undefined, "So11111111111111111111111111111111111111112", "invalid-address"])(
    "maps the withdrawal plan without parsing or forwarding refund hint %s",
    async (rentRefundTo) => {
      const resolvedRpcUrl = "https://devnet.example.invalid";
      const probe = new KaminoVaultDirectClient(async () => resolvedRpcUrl, runOperation);
      const slot = 456n;
      const getSlotSend = vi.fn().mockResolvedValue(slot);
      mocks.createKaminoRpc.mockReturnValue({ getSlot: () => ({ send: getSlotSend }) });

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

      const plan = await probe.buildVaultWithdrawal(
        { env: {}, environment: "sandbox" },
        { providerReference: vault, owner, shares: "2", rentRefundTo }
      );

      expect(mocks.createKaminoRpc).toHaveBeenCalledWith(resolvedRpcUrl);
      expect(getSlotSend).toHaveBeenCalledOnce();
      expect(mocks.buildKaminoWithdrawPlan).toHaveBeenCalledWith(
        { cluster: "devnet", rpcUrl: resolvedRpcUrl },
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
    const resolvedRpcUrl = "https://devnet.example.invalid";
    const probe = new KaminoVaultDirectClient(async () => resolvedRpcUrl, runOperation);
    const slot = 789n;
    const getSlotSend = vi.fn().mockResolvedValue(slot);
    mocks.createKaminoRpc.mockReturnValue({ getSlot: () => ({ send: getSlotSend }) });
    const issues = [{ code: "DEPOSIT_CAP_EXCEEDED", message: "Cap exceeded" }];
    mocks.quoteKaminoDeposit.mockResolvedValue({ sharesOut: "0.999", shareDecimals: 6, issues });
    const vault = "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx";

    const quote = await probe.quoteVaultDeposit(
      { env: {}, environment: "sandbox" },
      { providerReference: vault, amount: "1" }
    );

    expect(mocks.createKaminoRpc).toHaveBeenCalledWith(resolvedRpcUrl);
    expect(getSlotSend).toHaveBeenCalledOnce();
    expect(mocks.quoteKaminoDeposit).toHaveBeenCalledWith(
      { cluster: "devnet", rpcUrl: resolvedRpcUrl },
      { vault: address(vault), amount: "1", slot },
      expect.any(Function)
    );
    expect(quote).toEqual({ sharesOut: "0.999", shareDecimals: 6, blockingIssues: issues });
  });

  it("prices the withdrawal quote against one slot and maps it to the Earn contract", async () => {
    const resolvedRpcUrl = "https://devnet.example.invalid";
    const probe = new KaminoVaultDirectClient(async () => resolvedRpcUrl, runOperation);
    const slot = 790n;
    const getSlotSend = vi.fn().mockResolvedValue(slot);
    mocks.createKaminoRpc.mockReturnValue({ getSlot: () => ({ send: getSlotSend }) });
    const issues = [{ code: "INSUFFICIENT_WITHDRAWAL_LIQUIDITY", message: "Short" }];
    mocks.quoteKaminoWithdraw.mockResolvedValue({ assetsOut: "4.997", assetDecimals: 6, issues });
    const vault = "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx";

    const quote = await probe.quoteVaultWithdrawal(
      { env: {}, environment: "sandbox" },
      { providerReference: vault, shares: "5" }
    );

    expect(getSlotSend).toHaveBeenCalledOnce();
    expect(mocks.quoteKaminoWithdraw).toHaveBeenCalledWith(
      { cluster: "devnet", rpcUrl: resolvedRpcUrl },
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

  it("refuses to build when no RPC endpoint is configured for the cluster", async () => {
    const unconfigured = new KaminoVaultDirectClient(async () => "  ", runOperation);
    await expect(
      unconfigured.buildVaultDeposit(
        { env: {}, environment: "sandbox" },
        {
          providerReference: "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx",
          owner: "11111111111111111111111111111112",
          amount: "1",
        }
      )
      // Fails before any network call, the same fail-closed rule @sdp/earn
      // applies to a missing credential.
    ).rejects.toThrow(/No Solana RPC endpoint configured for devnet/);
  });

  it("maps the SDP environment to the right cluster", async () => {
    const seen: string[] = [];
    const probe = new KaminoVaultDirectClient(async (_ctx, cluster) => {
      seen.push(cluster);
      return "";
    }, runOperation);
    for (const environment of ["sandbox", "production"] as const) {
      await probe
        .buildVaultDeposit(
          { env: {}, environment },
          {
            providerReference: "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx",
            owner: "11111111111111111111111111111112",
            amount: "1",
          }
        )
        .catch(() => undefined);
    }
    // sandbox -> devnet, production -> mainnet-beta, via CLUSTER_BY_SDP_ENVIRONMENT
    // rather than a second copy of that mapping.
    expect(seen).toEqual(["devnet", "mainnet-beta"]);
  });

  it("requires the proven RPC resolver before any chain work", async () => {
    const resolverError = new Error("RPC endpoint was not proven");
    const unproven = new KaminoVaultDirectClient(async () => {
      throw resolverError;
    }, runOperation);

    await expect(
      unproven.buildVaultDeposit(
        { env: {}, environment: "sandbox" },
        {
          providerReference: "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx",
          owner: "11111111111111111111111111111112",
          amount: "1",
        }
      )
    ).rejects.toBe(resolverError);
    await expect(
      unproven.readVaultPositions(
        { env: {}, environment: "sandbox" },
        {
          owner: "11111111111111111111111111111112",
          providerReferences: ["7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx"],
        }
      )
    ).rejects.toBe(resolverError);

    expect(mocks.buildKaminoDepositPlan).not.toHaveBeenCalled();
    expect(mocks.discoverKaminoPositionVaults).not.toHaveBeenCalled();
    expect(mocks.createKaminoRpc).not.toHaveBeenCalled();
    expect(mocks.createKaminoReadRpc).not.toHaveBeenCalled();
    expect(mocks.readKaminoPositions).not.toHaveBeenCalled();
  });

  it("does not start provider work when endpoint proof finishes after expiry", async () => {
    let resolveRpc!: (url: string) => void;
    let expired = false;
    const probe = new KaminoVaultDirectClient(
      () =>
        new Promise<string>((resolve) => {
          resolveRpc = resolve;
        }),
      (_label, operation) =>
        operation(() => {
          if (expired) throw new Error("vault operation expired");
        })
    );

    const pending = probe.buildVaultDeposit(
      { env: {}, environment: "sandbox" },
      {
        providerReference: "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx",
        owner: "11111111111111111111111111111112",
        amount: "1",
      }
    );
    await vi.waitFor(() => expect(resolveRpc).toBeTypeOf("function"));

    expired = true;
    resolveRpc("https://devnet.example.invalid");

    await expect(pending).rejects.toThrow("vault operation expired");
    expect(mocks.buildKaminoDepositPlan).not.toHaveBeenCalled();
  });

  it("discovers owner-held vaults on chain without consulting the curated shelf", async () => {
    const resolvedRpcUrl = "https://devnet.example.invalid";
    const resolveRpcUrl = vi.fn(async () => resolvedRpcUrl);
    const probe = new KaminoVaultDirectClient(resolveRpcUrl, runOperation);
    const slot = 123n;
    const getSlotSend = vi.fn().mockResolvedValue(slot);
    mocks.createKaminoReadRpc.mockReturnValue({ getSlot: () => ({ send: getSlotSend }) });

    const providerReferences = ["7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx", SHARE_MINT];
    const owner = "11111111111111111111111111111112";
    mocks.discoverKaminoPositionVaults.mockResolvedValue(providerReferences.map(address));
    const listStrategies = vi.spyOn(probe, "listStrategies");
    mocks.readKaminoPositions.mockImplementation(
      async (runtime: KaminoRuntime, input: { vaults: string[]; owner: string }) =>
        input.vaults.map((vault) => ({
          status: "fulfilled",
          value: position(runtime, vault, input.owner, vault === providerReferences[1] ? "0" : "1"),
        }))
    );
    const processEnv = {
      SOLANA_RPC_URL: "https://process-mainnet.example.invalid",
      UNRELATED: "preserved",
    };

    const positions = await probe.readVaultPositions(
      {
        environment: "sandbox",
        env: processEnv,
      },
      {
        owner,
        providerReferences: [],
      }
    );

    expect(resolveRpcUrl).toHaveBeenCalledWith(
      {
        environment: "sandbox",
        env: processEnv,
      },
      "devnet"
    );
    expect(mocks.discoverKaminoPositionVaults).toHaveBeenCalledWith(
      { cluster: "devnet", rpcUrl: resolvedRpcUrl },
      address(owner),
      expect.any(Function)
    );
    expect(listStrategies).not.toHaveBeenCalled();
    expect(mocks.createKaminoReadRpc).toHaveBeenCalledWith(resolvedRpcUrl);
    expect(getSlotSend).toHaveBeenCalledOnce();
    expect(positions.map((entry) => entry.providerReference)).toEqual([providerReferences[0]]);
    expect(mocks.readKaminoPositions).toHaveBeenCalledOnce();
    expect(mocks.readKaminoPositions).toHaveBeenCalledWith(
      { cluster: "devnet", rpcUrl: resolvedRpcUrl },
      { vaults: providerReferences, owner: address(owner), slot },
      expect.any(Function)
    );
  });

  it("returns an empty snapshot without slot or hydration reads when discovery finds no holdings", async () => {
    const probe = new KaminoVaultDirectClient(
      async () => "https://devnet.example.invalid",
      runOperation
    );
    mocks.discoverKaminoPositionVaults.mockResolvedValue([]);

    await expect(
      probe.readVaultPositions(
        { env: {}, environment: "sandbox" },
        {
          owner: "11111111111111111111111111111112",
          providerReferences: [],
        }
      )
    ).resolves.toEqual([]);

    expect(mocks.discoverKaminoPositionVaults).toHaveBeenCalledOnce();
    expect(mocks.createKaminoReadRpc).not.toHaveBeenCalled();
    expect(mocks.readKaminoPositions).not.toHaveBeenCalled();
  });

  it("propagates on-chain discovery failures instead of reporting no holdings", async () => {
    const probe = new KaminoVaultDirectClient(
      async () => "https://devnet.example.invalid",
      runOperation
    );
    const discoveryError = new Error("program census unavailable");
    mocks.discoverKaminoPositionVaults.mockRejectedValue(discoveryError);

    await expect(
      probe.readVaultPositions(
        { env: {}, environment: "sandbox" },
        {
          owner: "11111111111111111111111111111112",
          providerReferences: [],
        }
      )
    ).rejects.toBe(discoveryError);

    expect(mocks.createKaminoReadRpc).not.toHaveBeenCalled();
    expect(mocks.readKaminoPositions).not.toHaveBeenCalled();
  });

  it("fails the whole snapshot when any discovered vault cannot be hydrated", async () => {
    const slot = 123n;
    mocks.createKaminoReadRpc.mockReturnValue({
      getSlot: () => ({ send: vi.fn().mockResolvedValue(slot) }),
    });

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
    const getSlotSend = vi.fn().mockResolvedValue(slot);
    mocks.createKaminoReadRpc.mockReturnValue({ getSlot: () => ({ send: getSlotSend }) });
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

    expect(getSlotSend).toHaveBeenCalledOnce();
    expect(mocks.createKaminoRpc).not.toHaveBeenCalled();
    expect(mocks.discoverKaminoPositionVaults).not.toHaveBeenCalled();
    expect(mocks.readKaminoPositions).toHaveBeenCalledOnce();
    expect(mocks.readKaminoPositions.mock.calls[0]?.[1]).toMatchObject({
      vaults: providerReferences,
      slot,
    });
  });

  it("does not start the page read after the operation expires", async () => {
    let expired = false;
    const probe = new KaminoVaultDirectClient(
      async () => "https://devnet.example.invalid",
      (_label, operation) =>
        operation(() => {
          if (expired) throw new Error("vault operation expired");
        })
    );
    mocks.createKaminoReadRpc.mockReturnValue({
      getSlot: () => ({
        send: vi.fn(async () => {
          expired = true;
          return 123n;
        }),
      }),
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
