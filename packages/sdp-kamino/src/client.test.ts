import {
  supportsPortfolioWallets,
  supportsVaultDirect,
  supportsVaultWithdraw,
} from "@sdp/earn/capabilities";
import { type Address, address } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertNotPortfolioProvider,
  KAMINO_POSITION_READ_CONCURRENCY,
  KaminoVaultDirectClient,
  toEarnVaultTransactionPlan,
} from "./client";
import type { KaminoInstructionPlan, KaminoPosition, KaminoRuntime } from "./types";

const DEPOSIT_TOKEN_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SHARE_MINT = "So11111111111111111111111111111111111111112";

const mocks = vi.hoisted(() => ({
  buildKaminoDepositPlan: vi.fn(),
  createKaminoRpc: vi.fn(),
  discoverKaminoPositionVaults: vi.fn(),
  readKaminoPosition: vi.fn(),
}));

vi.mock("./rpc", () => ({ createKaminoRpc: mocks.createKaminoRpc }));
vi.mock("./sdk", () => ({
  buildKaminoDepositPlan: mocks.buildKaminoDepositPlan,
  discoverKaminoPositionVaults: mocks.discoverKaminoPositionVaults,
  readKaminoPosition: mocks.readKaminoPosition,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

const client = new KaminoVaultDirectClient(() => "https://example.invalid");

describe("KaminoVaultDirectClient capabilities", () => {
  it("reports the vault-direct capability", () => {
    expect(supportsVaultDirect(client)).toBe(true);
  });

  /**
   * The withdraw capability is WITHHELD on purpose, and this pins it so that
   * implementing `buildVaultWithdrawal` cannot happen by accident.
   *
   * `buildKaminoWithdrawPlan` returns every unstake/withdraw/cleanup
   * instruction in ONE batch with no lookup table, while the pinned SDK
   * documents that a multi-reserve exit may need several transactions.
   * Answering yes here would let a future exit route narrow onto this client
   * and receive a plan the API submitter refuses — after the customer was told
   * their withdrawal was prepared. Deleting this test is the wrong way to make
   * it pass; batching the plan is the right way.
   */
  it("does NOT report the withdraw capability until the plan is batched", () => {
    expect(supportsVaultWithdraw(client)).toBe(false);
    expect((client as unknown as Record<string, unknown>).buildVaultWithdrawal).toBeUndefined();
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
    const unconfigured = new KaminoVaultDirectClient(() => "  ");
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
    const probe = new KaminoVaultDirectClient((_ctx, cluster) => {
      seen.push(cluster);
      return "";
    });
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

  it("discovers owner-held vaults on chain without consulting the curated shelf", async () => {
    const resolvedRpcUrl = "https://devnet.example.invalid";
    const resolveRpcUrl = vi.fn(() => resolvedRpcUrl);
    const probe = new KaminoVaultDirectClient(resolveRpcUrl);
    const slot = 123n;
    const getSlotSend = vi.fn().mockResolvedValue(slot);
    mocks.createKaminoRpc.mockReturnValue({ getSlot: () => ({ send: getSlotSend }) });

    const providerReferences = ["7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx", SHARE_MINT];
    const owner = "11111111111111111111111111111112";
    mocks.discoverKaminoPositionVaults.mockResolvedValue(providerReferences.map(address));
    const listStrategies = vi.spyOn(probe, "listStrategies");
    mocks.readKaminoPosition.mockImplementation(
      async (
        runtime: KaminoRuntime,
        input: { vault: Address; owner: Address; slot: bigint }
      ): Promise<KaminoPosition> => ({
        vault: input.vault,
        owner: input.owner,
        cluster: runtime.cluster,
        shares: String(input.vault) === providerReferences[1] ? "0" : "1",
        tokenMint: address(DEPOSIT_TOKEN_MINT),
        sharesMint: address(SHARE_MINT),
      })
    );

    const positions = await probe.readVaultPositions(
      {
        environment: "sandbox",
        env: {
          SOLANA_RPC_URL: "https://process-mainnet.example.invalid",
          UNRELATED: "preserved",
        },
      },
      {
        owner,
        providerReferences: [],
      }
    );

    expect(resolveRpcUrl).toHaveBeenCalledWith(
      {
        environment: "sandbox",
        env: {
          SOLANA_RPC_URL: "https://process-mainnet.example.invalid",
          UNRELATED: "preserved",
        },
      },
      "devnet"
    );
    expect(mocks.discoverKaminoPositionVaults).toHaveBeenCalledWith(
      { cluster: "devnet", rpcUrl: resolvedRpcUrl },
      address(owner)
    );
    expect(listStrategies).not.toHaveBeenCalled();
    expect(mocks.createKaminoRpc).toHaveBeenCalledWith(resolvedRpcUrl);
    expect(getSlotSend).toHaveBeenCalledOnce();
    expect(positions.map((position) => position.providerReference)).toEqual([
      providerReferences[0],
    ]);
    expect(
      mocks.readKaminoPosition.mock.calls.map(([runtime, input]) => ({
        cluster: runtime.cluster,
        rpcUrl: runtime.rpcUrl,
        vault: String(input.vault),
        slot: input.slot,
      }))
    ).toEqual(
      providerReferences.map((vault) => ({
        cluster: "devnet",
        rpcUrl: resolvedRpcUrl,
        vault,
        slot,
      }))
    );
  });

  it("returns an empty snapshot without slot or hydration reads when discovery finds no holdings", async () => {
    const probe = new KaminoVaultDirectClient(() => "https://devnet.example.invalid");
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
    expect(mocks.createKaminoRpc).not.toHaveBeenCalled();
    expect(mocks.readKaminoPosition).not.toHaveBeenCalled();
  });

  it("propagates on-chain discovery failures instead of reporting no holdings", async () => {
    const probe = new KaminoVaultDirectClient(() => "https://devnet.example.invalid");
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

    expect(mocks.createKaminoRpc).not.toHaveBeenCalled();
    expect(mocks.readKaminoPosition).not.toHaveBeenCalled();
  });

  it("fails the whole snapshot when any discovered vault cannot be hydrated", async () => {
    const slot = 123n;
    mocks.createKaminoRpc.mockReturnValue({
      getSlot: () => ({ send: vi.fn().mockResolvedValue(slot) }),
    });

    const owner = "11111111111111111111111111111112";
    const providerReferences = ["7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx", SHARE_MINT];
    mocks.discoverKaminoPositionVaults.mockResolvedValue(providerReferences.map(address));
    mocks.readKaminoPosition.mockImplementation(
      async (
        runtime: KaminoRuntime,
        input: { vault: Address; owner: Address }
      ): Promise<KaminoPosition> => {
        if (String(input.vault) === SHARE_MINT) throw new Error("RPC unavailable");
        return {
          vault: input.vault,
          owner: input.owner,
          cluster: runtime.cluster,
          shares: "1",
          tokenMint: address(DEPOSIT_TOKEN_MINT),
          sharesMint: address(SHARE_MINT),
        };
      }
    );

    await expect(
      client.readVaultPositions(
        { env: {}, environment: "sandbox" },
        { owner, providerReferences: [] }
      )
    ).rejects.toMatchObject({
      code: "VAULT_UNREADABLE",
      message: expect.stringMatching(/refusing to return a partial portfolio/),
    });
    expect(mocks.readKaminoPosition).toHaveBeenCalledTimes(2);
  });

  it("reads vaults with bounded concurrency against one shared slot", async () => {
    const slot = 123n;
    const getSlotSend = vi.fn().mockResolvedValue(slot);
    mocks.createKaminoRpc.mockReturnValue({ getSlot: () => ({ send: getSlotSend }) });

    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    mocks.readKaminoPosition.mockImplementation(
      async (
        runtime: KaminoRuntime,
        input: { vault: Address; owner: Address; slot: bigint }
      ): Promise<KaminoPosition> => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        return {
          vault: input.vault,
          owner: input.owner,
          cluster: runtime.cluster,
          shares: "1",
          tokenMint: input.vault,
          sharesMint: input.vault,
        };
      }
    );

    const vault = "7uib8xGAwkaPz4ZGCA6t8sSEid5Yp9ty13PHUweTypx";
    const providerReferences = Array.from({ length: 9 }, () => vault);
    const pending = client.readVaultPositions(
      { env: {}, environment: "sandbox" },
      {
        owner: "11111111111111111111111111111112",
        providerReferences,
      }
    );

    await vi.waitFor(() =>
      expect(mocks.readKaminoPosition).toHaveBeenCalledTimes(KAMINO_POSITION_READ_CONCURRENCY)
    );
    for (const release of releases.splice(0)) release();

    await vi.waitFor(() =>
      expect(mocks.readKaminoPosition).toHaveBeenCalledTimes(KAMINO_POSITION_READ_CONCURRENCY * 2)
    );
    for (const release of releases.splice(0)) release();

    await vi.waitFor(() => expect(mocks.readKaminoPosition).toHaveBeenCalledTimes(9));
    for (const release of releases.splice(0)) release();

    await expect(pending).resolves.toHaveLength(9);
    expect(maxActive).toBe(KAMINO_POSITION_READ_CONCURRENCY);
    expect(getSlotSend).toHaveBeenCalledOnce();
    expect(mocks.discoverKaminoPositionVaults).not.toHaveBeenCalled();
    expect(mocks.readKaminoPosition.mock.calls.every(([, input]) => input.slot === slot)).toBe(
      true
    );
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
      transactions: [],
      lookupTables: [],
      assetIdentity: {
        depositTokenMint: DEPOSIT_TOKEN_MINT,
        shareMint: SHARE_MINT,
      },
      accepted: { amount: "1.5", minSharesOut: "1.49" },
    });
  });
});
