/**
 * The mint pre-flight, against synthesised mint accounts.
 *
 * Each case encodes a REAL mint with `getMintEncoder`, so the bytes under test
 * are the ones the token program itself produces. A hand-written byte fixture
 * would only prove the parser agrees with my guess at the layout — the exact
 * "fixture that invents the upstream contract" failure.
 *
 * The deny-list itself was additionally verified against live devnet mints:
 * `G9eZJmGKw9aE2mpzoqfxpnS59hSU48ar7n23ckvyciY1` (ScaledUiAmount, which
 * `CreateDvp` rejects) is refused here for the same reason the program refuses
 * it, and `ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1` — the same mint minus
 * that extension, which the program accepts — passes.
 */

import { type Address, address, none, some, unixTimestamp } from "@solana/kit";
import { getSysvarClockEncoder, SYSVAR_CLOCK_ADDRESS } from "@solana/sysvars";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  type ExtensionArgs,
  extension,
  getMintEncoder,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@solana-program/token-2022";
import { describe, expect, it, vi } from "vitest";
import { syntheticAddress } from "@/test/helpers/parsed-transactions";
import { validateDvpMints } from "./mints";

const MINT_A = syntheticAddress(4_101);
const AUTHORITY = syntheticAddress(4_102);

function encodeMint(extensions: ExtensionArgs[]): Uint8Array {
  return new Uint8Array(
    getMintEncoder().encode({
      mintAuthority: some(AUTHORITY),
      supply: 0n,
      decimals: 6,
      isInitialized: true,
      freezeAuthority: some(AUTHORITY),
      extensions: extensions.length > 0 ? some(extensions) : none(),
    })
  );
}

function wireAccount(account: { owner: Address; data: Uint8Array }) {
  return {
    owner: account.owner,
    data: [Buffer.from(account.data).toString("base64"), "base64"],
    lamports: 1n,
    executable: false,
    space: BigInt(account.data.length),
  };
}

const CLOCK = wireAccount({
  owner: address("Sysvar1111111111111111111111111111111111111"),
  data: new Uint8Array(
    getSysvarClockEncoder().encode({
      slot: 900n,
      epochStartTimestamp: unixTimestamp(1_799_990_000n),
      epoch: 700n,
      leaderScheduleEpoch: 701n,
      unixTimestamp: unixTimestamp(1_800_000_000n),
    })
  ),
});

/**
 * An RPC whose only job is to answer `getMultipleAccounts` for the Clock and
 * the mint under test, in the base64 wire format `fetchEncodedAccounts` expects.
 */
function rpcReturning(account: { owner: Address; data: Uint8Array } | null) {
  return {
    getMultipleAccounts: (addresses: readonly string[]) => ({
      send: async () => ({
        value: addresses.map((at) => {
          if (at === SYSVAR_CLOCK_ADDRESS) return CLOCK;
          return account === null ? null : wireAccount(account);
        }),
      }),
    }),
  } as never;
}

const leg = (tokenProgram: Address = TOKEN_2022_PROGRAM_ADDRESS) => [
  { label: "mintA", mint: MINT_A, tokenProgram },
];

describe("validateDvpMints", () => {
  it("accepts a Token-2022 mint with no extensions", async () => {
    const rpc = rpcReturning({ owner: TOKEN_2022_PROGRAM_ADDRESS, data: encodeMint([]) });

    await expect(validateDvpMints(rpc, leg())).resolves.toEqual([]);
  });

  // The program's carve-outs. Refusing these would block regulated RWA issuance,
  // which is exactly what PermanentDelegate exists for.
  it("accepts the extensions the program explicitly allows", async () => {
    const rpc = rpcReturning({
      owner: TOKEN_2022_PROGRAM_ADDRESS,
      data: encodeMint([
        extension("PermanentDelegate", { delegate: AUTHORITY }),
        extension("DefaultAccountState", { state: 2 }),
      ]),
    });

    await expect(validateDvpMints(rpc, leg())).resolves.toEqual([]);
  });

  it.each([
    [
      "ScaledUiAmountConfig",
      extension("ScaledUiAmountConfig", {
        authority: AUTHORITY,
        multiplier: 1,
        newMultiplierEffectiveTimestamp: 0n,
        newMultiplier: 1,
      }),
    ],
    ["NonTransferable", extension("NonTransferable", {})],
  ])("refuses a mint carrying %s", async (name, ext) => {
    const rpc = rpcReturning({ owner: TOKEN_2022_PROGRAM_ADDRESS, data: encodeMint([ext]) });

    const problems = await validateDvpMints(rpc, leg());

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(name);
  });

  // The program accepts a hook mint, but every transfer out of the escrow needs
  // the hook's extra accounts, which SDP does not resolve. Settle, cancel and
  // reclaim would all fail, so a funded leg would have no way out.
  it("refuses a transfer-hook mint as one SDP cannot move yet", async () => {
    const rpc = rpcReturning({
      owner: TOKEN_2022_PROGRAM_ADDRESS,
      data: encodeMint([extension("TransferHook", { authority: AUTHORITY, programId: AUTHORITY })]),
    });

    const problems = await validateDvpMints(rpc, leg());

    expect(problems).toEqual([
      `mintA ${MINT_A} carries the TransferHook extension, which SDP cannot settle, cancel or reclaim yet`,
    ]);
  });

  // The escrow ATA derives from (swapDvp, mint, tokenProgram). Believing the
  // caller's declared program over the account's actual owner would publish an
  // escrow address derived under the wrong program.
  it("refuses a mint whose owner is not the declared token program", async () => {
    const rpc = rpcReturning({ owner: TOKEN_2022_PROGRAM_ADDRESS, data: encodeMint([]) });

    const problems = await validateDvpMints(rpc, leg(TOKEN_PROGRAM_ADDRESS));

    expect(problems[0]).toContain("is owned by");
  });

  it("refuses a token program that is not an SPL token program", async () => {
    const rpc = rpcReturning({ owner: TOKEN_2022_PROGRAM_ADDRESS, data: encodeMint([]) });

    const problems = await validateDvpMints(rpc, leg(address("11111111111111111111111111111111")));

    expect(problems[0]).toContain("is not an SPL token program");
  });

  it("refuses a mint that does not exist", async () => {
    const problems = await validateDvpMints(rpcReturning(null), leg());

    expect(problems[0]).toContain("does not exist");
  });

  // A wallet or token account pasted as a mint must come back as a named 400,
  // not a decode crash: the owner check is judged on the raw account, and only
  // then does the extensions check attempt to decode.
  it("refuses undecodable bytes via the owner check rather than throwing", async () => {
    const rpc = rpcReturning({
      owner: address("11111111111111111111111111111111"),
      data: new Uint8Array([1, 2, 3]),
    });

    const problems = await validateDvpMints(rpc, leg());

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("is owned by");
  });

  // The program would still refuse its own four on chain, but not a transfer
  // hook, so a mint SDP cannot read is refused rather than let through.
  it("refuses a token-2022 mint whose bytes do not decode", async () => {
    const rpc = rpcReturning({
      owner: TOKEN_2022_PROGRAM_ADDRESS,
      data: new Uint8Array([1, 2, 3]),
    });

    await expect(validateDvpMints(rpc, leg())).resolves.toEqual([
      `mintA ${MINT_A} has extension data SDP cannot read, so it cannot confirm the mint is settleable`,
    ]);
  });

  // A legacy mint carries no extensions by construction, so there is nothing to
  // decode and the deny-list cannot apply.
  it("accepts a legacy SPL mint without inspecting extensions", async () => {
    const rpc = rpcReturning({ owner: TOKEN_PROGRAM_ADDRESS, data: encodeMint([]) });

    await expect(validateDvpMints(rpc, leg(TOKEN_PROGRAM_ADDRESS))).resolves.toEqual([]);
  });

  // Reporting one problem at a time would make a caller fix a payload by trial
  // and error, which is the same contract validateDvpTerms holds itself to.
  it("reports a problem on every leg at once, from one read", async () => {
    const getMultipleAccounts = vi.fn((addresses: readonly string[]) => ({
      send: async () => ({
        value: addresses.map((at) => (at === SYSVAR_CLOCK_ADDRESS ? CLOCK : null)),
      }),
    }));
    const rpc = { getMultipleAccounts } as never;

    const problems = await validateDvpMints(rpc, [
      { label: "mintA", mint: MINT_A, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS },
      { label: "mintB", mint: MINT_A, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS },
    ]);

    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("mintA");
    expect(problems[1]).toContain("mintB");
    expect(getMultipleAccounts).toHaveBeenCalledOnce();
  });

  // The `dvp` row of the capability table: a hook that can never run passes,
  // a pause is refused with its own reason, and every refusal is reported.
  it("accepts an immutable hook with no program, which can never run", async () => {
    const unset = address("11111111111111111111111111111111");
    const rpc = rpcReturning({
      owner: TOKEN_2022_PROGRAM_ADDRESS,
      data: encodeMint([extension("TransferHook", { authority: unset, programId: unset })]),
    });

    await expect(validateDvpMints(rpc, leg())).resolves.toEqual([]);
  });

  it("refuses a paused mint, and reports each refusal of one mint", async () => {
    const rpc = rpcReturning({
      owner: TOKEN_2022_PROGRAM_ADDRESS,
      data: encodeMint([
        extension("TransferFeeConfig", {
          transferFeeConfigAuthority: AUTHORITY,
          withdrawWithheldAuthority: AUTHORITY,
          withheldAmount: 0n,
          olderTransferFee: { epoch: 0n, maximumFee: 0n, transferFeeBasisPoints: 0 },
          newerTransferFee: { epoch: 0n, maximumFee: 0n, transferFeeBasisPoints: 0 },
        }),
        extension("PausableConfig", { authority: AUTHORITY, paused: true }),
      ]),
    });

    await expect(validateDvpMints(rpc, leg())).resolves.toEqual([
      `mintA ${MINT_A} carries the TransferFeeConfig extension, which DvP settlement refuses`,
      `mintA ${MINT_A} is paused, so no leg of it can be funded, settled or refunded`,
    ]);
  });
});
