import { MERGE_INPUT_COUNT } from "@heliuslabs/zolana/interface";
import { Data, type Wallet, type WalletUtxo } from "@heliuslabs/zolana/transaction";
import { type Address, address } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const buildMergeTransaction = vi.fn();

vi.mock("@heliuslabs/zolana/wallet", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@heliuslabs/zolana/wallet")>()),
  buildMergeTransaction: (...args: unknown[]) => buildMergeTransaction(...args),
}));

const { buildMerge } = await import("./spend.js");

const SDP_SOL = "So11111111111111111111111111111111111111112";
const SOL: Address = address("11111111111111111111111111111111");
const OTHER_ASSET: Address = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

interface NoteOptions {
  readonly asset?: Address;
  readonly data?: Data;
  readonly dataHash?: boolean;
  readonly spent?: boolean;
  readonly tree?: Address;
  readonly zoneDataHash?: boolean;
  readonly zoneProgramId?: boolean;
}

function bytes(value: number): WalletUtxo["outputContext"]["hash"] {
  return new Uint8Array(32).fill(value) as WalletUtxo["outputContext"]["hash"];
}

function note(commitment: number, amount: bigint, options: NoteOptions = {}): WalletUtxo {
  return {
    utxo: {
      asset: options.asset ?? SOL,
      amount,
      data: options.data ?? new Data(),
      ...(options.zoneProgramId ? { zoneProgramId: SOL } : {}),
    } as WalletUtxo["utxo"],
    outputContext: {
      hash: bytes(commitment),
      tree: options.tree ?? SOL,
      leafIndex: BigInt(commitment),
    },
    nullifier: bytes(commitment + 100),
    ...(options.dataHash ? { dataHash: bytes(commitment + 110) } : {}),
    ...(options.zoneDataHash ? { zoneDataHash: bytes(commitment + 120) } : {}),
    spent: options.spent ?? false,
  };
}

function deps(notes: readonly WalletUtxo[]): Parameters<typeof buildMerge>[0] {
  return {
    client: {} as never,
    wallet: { utxos: () => notes } as unknown as Wallet,
    authority: {} as never,
    material: {} as never,
    owner: SOL,
  };
}

function selectedCommitments(): number[] {
  const input = buildMergeTransaction.mock.calls[0]?.[0] as
    | { inputs?: readonly Uint8Array[] }
    | undefined;
  return input?.inputs?.map((hash) => hash[0] as number) ?? [];
}

describe("buildMerge note selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildMergeTransaction.mockResolvedValue({});
  });

  it("excludes every note shape Zolana's plain merge rail refuses", async () => {
    const nonemptyData = new Data([{ kind: "utxoData", bytes: Uint8Array.of(1) }]);
    const notes = [
      note(1, 1n, { data: nonemptyData }),
      note(2, 2n, { dataHash: true }),
      note(3, 3n, { zoneDataHash: true }),
      note(4, 4n, { zoneProgramId: true }),
      note(5, 5n, { spent: true }),
      note(6, 6n, { asset: OTHER_ASSET }),
      note(7, 70n),
      note(8, 80n),
    ];

    await buildMerge(deps(notes), { mint: SDP_SOL });

    expect(selectedCommitments()).toEqual([7, 8]);
  });

  it("rejects plain notes from multiple trees before selecting inputs", async () => {
    const result = buildMerge(deps([note(1, 10n), note(2, 20n, { tree: OTHER_ASSET })]), {
      mint: SDP_SOL,
    });

    await expect(result).rejects.toMatchObject({
      name: "WalletError",
      code: "WALLET_MULTIPLE_INPUT_TREES",
    });
    expect(buildMergeTransaction).not.toHaveBeenCalled();
  });

  it("takes the smallest notes first and caps them at the public merge input count", async () => {
    const notes = Array.from({ length: MERGE_INPUT_COUNT + 2 }, (_, index) =>
      note(index + 1, BigInt(100 - index))
    );

    await buildMerge(deps(notes), { mint: SDP_SOL });

    expect(selectedCommitments()).toEqual([10, 9, 8, 7, 6, 5, 4, 3]);
    expect(selectedCommitments()).toHaveLength(MERGE_INPUT_COUNT);
  });
});
