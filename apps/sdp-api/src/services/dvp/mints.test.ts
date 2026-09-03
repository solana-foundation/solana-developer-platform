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

import { type Address, none, some } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  type ExtensionArgs,
  extension,
  getMintEncoder,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@solana-program/token-2022";
import { describe, expect, it, vi } from "vitest";
import { validateDvpMints } from "./mints";

const MINT_A = "ns7Y4h26io6zGKiuvSx1jRBWANjDytnYyxEmVPfPAk1" as Address;
const AUTHORITY = "AMX5b8Rwt5yZd3Zdyfa7QcL6BYvLPS1uUqZGVRbe6DoC" as Address;

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

/** An RPC whose only job is to answer `getAccountInfo` for the mint under test. */
function rpcReturning(account: { owner: Address; data: Uint8Array } | null) {
  return {
    getAccountInfo: () => ({
      send: async () => ({ value: account }),
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

    const problems = await validateDvpMints(
      rpc,
      leg("11111111111111111111111111111111" as Address)
    );

    expect(problems[0]).toContain("is not an SPL token program");
  });

  it("refuses a mint that does not exist", async () => {
    const problems = await validateDvpMints(rpcReturning(null), leg());

    expect(problems[0]).toContain("does not exist");
  });

  // A legacy mint carries no extensions by construction, so there is nothing to
  // decode and the deny-list cannot apply.
  it("accepts a legacy SPL mint without inspecting extensions", async () => {
    const rpc = rpcReturning({ owner: TOKEN_PROGRAM_ADDRESS, data: encodeMint([]) });

    await expect(validateDvpMints(rpc, leg(TOKEN_PROGRAM_ADDRESS))).resolves.toEqual([]);
  });

  // Reporting one problem at a time would make a caller fix a payload by trial
  // and error, which is the same contract validateDvpTerms holds itself to.
  it("reports a problem on every leg at once", async () => {
    const rpc = {
      getAccountInfo: vi.fn().mockReturnValue({ send: async () => ({ value: null }) }),
    } as never;

    const problems = await validateDvpMints(rpc, [
      { label: "mintA", mint: MINT_A, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS },
      { label: "mintB", mint: MINT_A, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS },
    ]);

    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain("mintA");
    expect(problems[1]).toContain("mintB");
  });
});
