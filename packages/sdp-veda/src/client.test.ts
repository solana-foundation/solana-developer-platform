import {
  supportsPortfolioWallets,
  supportsVaultDirect,
  supportsVaultWithdraw,
} from "@sdp/earn/capabilities";
import type { VedaDeployment } from "@sdp/types/veda-programs";
import { address } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertNotPortfolioProvider,
  toEarnVaultTransactionPlan,
  VEDA_POSITION_READ_CONCURRENCY,
  VedaVaultDirectClient,
  type VedaVaultOperationRunner,
} from "./client";
import { SdpVedaError } from "./errors";
import { toClusterConfig } from "./programs";
import type { VedaInstructionPlan, VedaPosition } from "./types";

const VAULT_PROGRAM = "5J76xGGXn5op9S48pMqWV6Ex48ZxsKsRs4bGeDzSHEVc";
const QUEUE_PROGRAM = "Cchro8d7bN5Xfk77z9hJKxREJwSAjpz5K2seK4iNN396";
const HOOK_PROGRAM = "FSZPGBfPWb6fUQWSwiKv8de55NabpBWgPmB6RV7kDgv9";
const VAULT_A = "So11111111111111111111111111111111111111112";
const VAULT_B = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const DEPOSIT_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SHARE_MINT = "9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D";
const OWNER = "11111111111111111111111111111112";

const DEPLOYMENT: VedaDeployment = {
  vaultProgramAddress: VAULT_PROGRAM,
  queueProgramAddress: QUEUE_PROGRAM,
  hookProgramAddress: HOOK_PROGRAM,
  vaultStateAddresses: [VAULT_A, VAULT_B],
};

const mocks = vi.hoisted(() => ({
  buildVedaDepositPlan: vi.fn(),
  readVedaPosition: vi.fn(),
}));

vi.mock("./sdk", () => ({
  buildVedaDepositPlan: mocks.buildVedaDepositPlan,
  readVedaPosition: mocks.readVedaPosition,
}));

// Partial: only the registry lookup is replaced, so the address branding and
// the allowlist stay the real ones.
vi.mock("./programs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./programs")>();
  return { ...actual, vedaClusterConfig: () => actual.toClusterConfig("devnet", DEPLOYMENT) };
});

beforeEach(() => {
  vi.clearAllMocks();
});

const runOperation: VedaVaultOperationRunner = (_label, operation) => operation(() => undefined);
const client = new VedaVaultDirectClient(async () => "https://rpc.test.invalid", runOperation);
const sandbox = { env: {}, environment: "sandbox" } as const;

function plan(): VedaInstructionPlan {
  return {
    cluster: "devnet",
    instructions: [
      [
        {
          programAddress: address(VAULT_PROGRAM),
          accounts: [
            { address: address(OWNER), role: 3 },
            { address: address(VAULT_A), role: 1 },
          ],
          data: new Uint8Array([1, 2, 3, 4]),
        },
      ],
    ] as unknown as VedaInstructionPlan["instructions"],
    lookupTables: [],
    assetIdentity: { depositTokenMint: address(DEPOSIT_MINT), shareMint: address(SHARE_MINT) },
    accepted: { amount: "10", minSharesOut: "9.5" },
  };
}

function position(vault: string, overrides: Partial<VedaPosition> = {}): VedaPosition {
  return {
    vault: address(vault),
    owner: address(OWNER),
    cluster: "devnet",
    shares: "5",
    tokenValue: "5.25",
    tokenMint: address(DEPOSIT_MINT),
    shareMint: address(SHARE_MINT),
    ...overrides,
  };
}

describe("VedaVaultDirectClient capabilities", () => {
  it("reports the vault-direct capability", () => {
    expect(supportsVaultDirect(client)).toBe(true);
  });

  /**
   * The withdraw capability is WITHHELD, and this pins it so implementing
   * `buildVaultWithdrawal` cannot happen by accident.
   *
   * Veda offers two independent exits — instant redemption and a
   * request/fulfil queue — and neither has an SDP route: there is no
   * `POST /vault-withdrawals`, and the queue's lifecycle does not fit the
   * `pending|submitted|confirmed|failed` movement model the deposit path uses.
   * Answering yes here would let a future exit route narrow onto this client
   * and receive a plan nothing can carry, after the customer was told their
   * withdrawal was prepared. Deleting this test is the wrong way to make it
   * pass; landing the withdrawal design is the right way.
   */
  it("does NOT report the withdraw capability until the exit route exists", () => {
    expect(supportsVaultWithdraw(client)).toBe(false);
    expect((client as unknown as Record<string, unknown>).buildVaultWithdrawal).toBeUndefined();
  });

  /**
   * THE INVARIANT THAT PROTECTS CUSTOMER FUNDS.
   *
   * The portfolio capability means "SDP can give you an address to send
   * stablecoins to". Veda has no such address — its vault state is a program
   * account. If this client ever answered yes to both, a portfolio route could
   * render that account as a deposit target. The two must stay mutually
   * exclusive.
   */
  it("NEVER reports the portfolio-wallet capability", () => {
    expect(supportsPortfolioWallets(client)).toBe(false);
    expect(() => assertNotPortfolioProvider(client)).not.toThrow();
  });

  it("still catalogues — the execution client is a superset, not a replacement", () => {
    expect(client.provider).toBe("veda");
    expect(client.declaredSupport.sourceKinds).toEqual(["defi"]);
    expect(client.declaredSupport.depositTokens).toEqual(["USDC"]);
    expect(typeof client.listStrategies).toBe("function");
  });
});

describe("buildVaultDeposit", () => {
  const input = {
    providerReference: VAULT_A,
    owner: OWNER,
    amount: "10",
    minSharesOut: "9.5",
  };

  /**
   * Veda's SDK refuses an implicit slippage tolerance, and SDP refuses to
   * invent one: a floor nobody chose is not protection, it is the appearance of
   * it. The API requires a floor only in production; for Veda it is required
   * everywhere, so this fails BEFORE any chain work.
   */
  it("refuses a deposit with no slippage floor, before touching the chain", async () => {
    const { minSharesOut: _omitted, ...noFloor } = input;
    await expect(client.buildVaultDeposit(sandbox, noFloor)).rejects.toMatchObject({
      code: "INVALID_AMOUNT",
    });
    expect(mocks.buildVedaDepositPlan).not.toHaveBeenCalled();
  });

  it("refuses to build when no RPC endpoint is configured for the cluster", async () => {
    const unconfigured = new VedaVaultDirectClient(async () => "  ", runOperation);
    await expect(unconfigured.buildVaultDeposit(sandbox, input)).rejects.toMatchObject({
      code: "VAULT_UNREADABLE",
    });
    expect(mocks.buildVedaDepositPlan).not.toHaveBeenCalled();
  });

  it("passes the vault, owner and both amounts through as addresses and decimal strings", async () => {
    mocks.buildVedaDepositPlan.mockResolvedValue(plan());
    await client.buildVaultDeposit(sandbox, input);

    expect(mocks.buildVedaDepositPlan).toHaveBeenCalledTimes(1);
    const [runtime, config, built] = mocks.buildVedaDepositPlan.mock.calls[0] as [
      { cluster: string; rpcUrl: string },
      { vaultProgramAddress: string },
      { vault: string; owner: string; amount: string; minSharesOut: string },
    ];
    expect(runtime.cluster).toBe("devnet");
    expect(String(config.vaultProgramAddress)).toBe(VAULT_PROGRAM);
    expect({ ...built, vault: String(built.vault), owner: String(built.owner) }).toEqual({
      vault: VAULT_A,
      owner: OWNER,
      amount: "10",
      minSharesOut: "9.5",
    });
  });

  it("serializes the plan into the dependency-free Earn contract", async () => {
    mocks.buildVedaDepositPlan.mockResolvedValue(plan());
    const result = await client.buildVaultDeposit(sandbox, input);

    expect(result).toEqual({
      cluster: "devnet",
      transactions: [
        [
          {
            programAddress: VAULT_PROGRAM,
            accounts: [
              { address: OWNER, role: 3 },
              { address: VAULT_A, role: 1 },
            ],
            // Base64 keeps the plan JSON-safe across a queue or a log.
            data: Buffer.from([1, 2, 3, 4]).toString("base64"),
          },
        ],
      ],
      lookupTables: [],
      assetIdentity: { depositTokenMint: DEPOSIT_MINT, shareMint: SHARE_MINT },
      accepted: { amount: "10", minSharesOut: "9.5" },
    });
  });

  /**
   * The API ledgers `accepted`, not the raw request, because only the builder
   * knows each mint's precision. Dropping it reintroduces the drift between
   * what was recorded and what moved.
   */
  it("carries the encoded amounts, not the requested ones", async () => {
    const canonical = plan();
    canonical.accepted = { amount: "10", minSharesOut: "9.5" };
    mocks.buildVedaDepositPlan.mockResolvedValue(canonical);
    const result = await client.buildVaultDeposit(sandbox, {
      ...input,
      amount: "10.000",
      minSharesOut: "9.500000",
    });
    expect(result.accepted).toEqual({ amount: "10", minSharesOut: "9.5" });
  });
});

describe("toEarnVaultTransactionPlan", () => {
  it("tolerates an instruction with no accounts and no data", () => {
    const bare: VedaInstructionPlan = {
      ...plan(),
      instructions: [
        [{ programAddress: address(VAULT_PROGRAM) }],
      ] as unknown as VedaInstructionPlan["instructions"],
    };
    expect(toEarnVaultTransactionPlan(bare).transactions[0]?.[0]).toEqual({
      programAddress: VAULT_PROGRAM,
      accounts: [],
      data: "",
    });
  });
});

describe("readVaultPositions", () => {
  it("reads exactly the requested vaults", async () => {
    mocks.readVedaPosition.mockImplementation(
      async (_runtime: unknown, _config: unknown, input: { vault: string }) =>
        position(String(input.vault))
    );

    const snapshots = await client.readVaultPositions(sandbox, {
      owner: OWNER,
      providerReferences: [VAULT_A],
    });

    expect(mocks.readVedaPosition).toHaveBeenCalledTimes(1);
    expect(snapshots).toEqual([
      {
        providerReference: VAULT_A,
        owner: OWNER,
        cluster: "devnet",
        shares: "5",
        tokenValue: "5.25",
        tokenMint: DEPOSIT_MINT,
        shareMint: SHARE_MINT,
      },
    ]);
  });

  /**
   * Veda's SDK publishes no vault discovery, and there is nothing to discover:
   * a Veda vault reaches SDP only by being named in `VEDA_DEPLOYMENTS`, so the
   * configured shelf IS the set of vaults an owner could hold through SDP.
   */
  it("falls back to the configured shelf when no references are given", async () => {
    mocks.readVedaPosition.mockImplementation(
      async (_runtime: unknown, _config: unknown, input: { vault: string }) =>
        position(String(input.vault))
    );

    const snapshots = await client.readVaultPositions(sandbox, {
      owner: OWNER,
      providerReferences: [],
    });

    expect(snapshots.map((snapshot) => snapshot.providerReference)).toEqual([VAULT_A, VAULT_B]);
  });

  it("omits an empty holding from a full-shelf read but keeps a requested zero", async () => {
    mocks.readVedaPosition.mockImplementation(
      async (_runtime: unknown, _config: unknown, input: { vault: string }) =>
        position(String(input.vault), {
          shares: String(input.vault) === VAULT_B ? "0" : "5",
          tokenValue: undefined,
        })
    );

    const all = await client.readVaultPositions(sandbox, { owner: OWNER, providerReferences: [] });
    expect(all.map((snapshot) => snapshot.providerReference)).toEqual([VAULT_A]);

    const requested = await client.readVaultPositions(sandbox, {
      owner: OWNER,
      providerReferences: [VAULT_B],
    });
    expect(requested).toHaveLength(1);
    expect(requested[0]?.shares).toBe("0");
  });

  it("omits an unreadable valuation rather than fabricating one", async () => {
    mocks.readVedaPosition.mockResolvedValue(position(VAULT_A, { tokenValue: undefined }));
    const [only] = await client.readVaultPositions(sandbox, {
      owner: OWNER,
      providerReferences: [VAULT_A],
    });
    expect(only?.shares).toBe("5");
    expect(only && "tokenValue" in only).toBe(false);
  });

  /**
   * A partial portfolio is not a truthful portfolio: returning every other
   * vault would make a failed holding indistinguishable from no holding.
   */
  it("fails the whole read when any vault fails", async () => {
    mocks.readVedaPosition.mockImplementation(
      async (_runtime: unknown, _config: unknown, input: { vault: string }) => {
        if (String(input.vault) === VAULT_B) throw new Error("rpc exploded");
        return position(String(input.vault));
      }
    );

    await expect(
      client.readVaultPositions(sandbox, { owner: OWNER, providerReferences: [VAULT_A, VAULT_B] })
    ).rejects.toMatchObject({ code: "VAULT_UNREADABLE" });
  });

  it("stops dequeuing vaults once the caller's deadline has expired", async () => {
    let elapsed = false;
    const deadlined: VedaVaultOperationRunner = (_label, operation) =>
      operation(() => {
        if (elapsed) throw new SdpVedaError("VAULT_UNREADABLE", "deadline elapsed");
      });
    const bounded = new VedaVaultDirectClient(async () => "https://rpc.test.invalid", deadlined);
    mocks.readVedaPosition.mockImplementation(async () => {
      elapsed = true;
      return position(VAULT_A);
    });

    await expect(
      bounded.readVaultPositions(sandbox, { owner: OWNER, providerReferences: [VAULT_A, VAULT_B] })
    ).rejects.toThrow(/deadline elapsed/);
  });

  it("bounds concurrent vault reads", () => {
    expect(VEDA_POSITION_READ_CONCURRENCY).toBeGreaterThan(0);
    expect(VEDA_POSITION_READ_CONCURRENCY).toBeLessThanOrEqual(8);
  });
});

describe("an unconfigured deployment", () => {
  /**
   * The real registry is empty until Veda confirms addresses, so a client built
   * against it refuses every chain call. Asserted with the mock bypassed so
   * this is the genuine `@sdp/types` state, not the fixture's.
   */
  it("refuses both chain capabilities with a typed error", async () => {
    const { vedaClusterConfig } = await vi.importActual<typeof import("./programs")>("./programs");
    expect(() => vedaClusterConfig("devnet")).toThrowError(
      expect.objectContaining({ code: "DEPLOYMENT_NOT_CONFIGURED" })
    );
    expect(() => vedaClusterConfig("mainnet-beta")).toThrowError(
      expect.objectContaining({ code: "DEPLOYMENT_NOT_CONFIGURED" })
    );
  });

  it("still exposes the fixture-driven config helper the builder uses", () => {
    expect(toClusterConfig("devnet", DEPLOYMENT).cluster).toBe("devnet");
  });
});
