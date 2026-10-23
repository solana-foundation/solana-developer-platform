import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type CapabilityExtension, support } from "@sdp/solana/token-movement";
import { decodeTokenTerms, type MintTokenTerms } from "@sdp/solana/token-terms";
import { SPL_TOKEN_PROGRAMS, WELL_KNOWN_TOKEN_BY_MINT } from "@sdp/types/well-known-tokens";
import {
  type Address,
  address,
  type EncodedAccount,
  getAddressDecoder,
  lamports,
  unixTimestamp,
} from "@solana/kit";
import { getSysvarClockEncoder, SYSVAR_CLOCK_ADDRESS } from "@solana/sysvars";
import { AccountState, type ExtensionArgs, getMintEncoder } from "@solana-program/token-2022";
import { describe, expect, it } from "vitest";

/**
 * The builder's capability row (`support(terms, "builder")`, ADR 0012) must
 * agree with the Kora sponsor policy: Kora co-signs every Payments movement,
 * and a mint state the builder moves but Kora refuses to sponsor fails at
 * signing, after the movement is recorded.
 *
 * Same pattern and scope as `vault-sponsorship-allowlist.test.ts`: this reads
 * the LOCAL harness config (`infra/kora/kora.toml`), which mirrors the
 * deployed devnet validation policy. The deployed configs live in sdp-infra;
 * keep them in step by hand.
 *
 * - Every `allowed_tokens` mint is moved by the builder under its catalogue
 *   profile (PYUSD and USDG with their mainnet extension state).
 * - No mint extension the builder moves through is in
 *   `blocked_mint_extensions`, and no account extension a movement creates or
 *   meets is in `blocked_account_extensions`.
 * - The builder moves hook mints, and PYUSD/USDG keep a mutable hook
 *   authority, so Kora's `transfer_hook_policy` is `allow_all`: present in the
 *   harness only past the legacy image, and stated for the deployed configs.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS_CONFIG = resolve(HERE, "../../../../../infra/kora/kora.toml");
const CONFIG = readFileSync(HARNESS_CONFIG, "utf8");

/** The quoted entries of a `<key> = [ ... ]` TOML array; fails loudly when the key is missing. */
function tomlStringArray(key: string): readonly string[] {
  const block = new RegExp(`^${key}\\s*=\\s*\\[([^\\]]*)\\]`, "m").exec(CONFIG);
  if (block?.[1] === undefined) {
    throw new Error(`Could not find ${key} in ${HARNESS_CONFIG}`);
  }
  return [...block[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

/** The effective transfer-hook policy, ignoring the comments that explain its omission. */
function transferHookPolicy(): string | undefined {
  return /^\s*transfer_hook_policy\s*=\s*"([^"]+)"\s*(?:#.*)?$/m.exec(CONFIG)?.[1];
}

/** Kora's names for the mint extensions a capability row decides, as `blocked_mint_extensions` takes them. */
const KORA_MINT_EXTENSION_NAMES = {
  NonTransferable: "non_transferable",
  PausableConfig: "pausable",
  DefaultAccountState: "default_account_state",
  TransferFeeConfig: "transfer_fee_config",
  ScaledUiAmountConfig: "scaled_ui_amount",
  InterestBearingConfig: "interest_bearing_config",
  TransferHook: "transfer_hook",
} as const satisfies Record<CapabilityExtension, string>;

/** Mint extensions no row decides, which the builder moves through whatever their state. */
const KORA_PASSIVE_MINT_EXTENSION_NAMES = {
  PermanentDelegate: "permanent_delegate",
  ConfidentialTransferMint: "confidential_transfer_mint",
  MintCloseAuthority: "mint_close_authority",
} as const;

/**
 * Account extensions a builder movement creates (a destination's required
 * extensions, and `ImmutableOwner` on every Token-2022 associated account) or
 * meets (a memo-required destination).
 */
const KORA_ACCOUNT_EXTENSION_NAMES = [
  "immutable_owner",
  "transfer_fee_amount",
  "transfer_hook_account",
  "pausable_account",
  "memo_transfer",
] as const;

const KNOWN_KORA_MINT_EXTENSIONS: ReadonlySet<string> = new Set([
  ...Object.values(KORA_MINT_EXTENSION_NAMES),
  ...Object.values(KORA_PASSIVE_MINT_EXTENSION_NAMES),
  "metadata_pointer",
  "group_pointer",
  "group_member_pointer",
]);

const KNOWN_KORA_ACCOUNT_EXTENSIONS: ReadonlySet<string> = new Set([
  ...KORA_ACCOUNT_EXTENSION_NAMES,
  "cpi_guard",
  "non_transferable_account",
  "confidential_transfer_account",
]);

const testAddress = (byte: number): Address =>
  getAddressDecoder().decode(new Uint8Array(32).fill(byte));
const AUTHORITY = testAddress(2);
const HOOK_PROGRAM = testAddress(3);
const UNSET = address("11111111111111111111111111111111");

function encoded(at: Address, owner: string, data: Uint8Array): EncodedAccount {
  return {
    address: at,
    data,
    executable: false,
    lamports: lamports(1n),
    programAddress: address(owner),
    space: BigInt(data.length),
  };
}

const CLOCK = encoded(
  SYSVAR_CLOCK_ADDRESS,
  "Sysvar1111111111111111111111111111111111111",
  new Uint8Array(
    getSysvarClockEncoder().encode({
      slot: 900n,
      epochStartTimestamp: unixTimestamp(1_799_990_000n),
      epoch: 700n,
      leaderScheduleEpoch: 701n,
      unixTimestamp: unixTimestamp(1_800_000_000n),
    })
  )
);

/** A mint's terms under `program`, decoded the way the planner decodes them. */
function mintTerms(
  mint: Address,
  program: "spl-token" | "token-2022",
  extensions: ExtensionArgs[] | null
): MintTokenTerms {
  const data = getMintEncoder().encode({
    mintAuthority: AUTHORITY,
    supply: 1_000_000n,
    decimals: 6,
    isInitialized: true,
    freezeAuthority: AUTHORITY,
    extensions,
  });
  return decodeTokenTerms(
    { kind: "mint", mint },
    { mint: encoded(mint, SPL_TOKEN_PROGRAMS[program], new Uint8Array(data)), clock: CLOCK }
  );
}

const zeroFee = { epoch: 0n, maximumFee: 0n, transferFeeBasisPoints: 0 };

/**
 * PYUSD's and USDG's extension state (`pnpm check:well-known-mints`,
 * 2026-10-22, ADR 0012): a 0-bps fee config, a hook with no program and a
 * mutable authority, a permanent delegate, confidential transfers and a close
 * authority.
 */
const PAXOS_STABLECOIN_EXTENSIONS: ExtensionArgs[] = [
  {
    __kind: "TransferFeeConfig",
    transferFeeConfigAuthority: AUTHORITY,
    withdrawWithheldAuthority: AUTHORITY,
    withheldAmount: 0n,
    olderTransferFee: zeroFee,
    newerTransferFee: zeroFee,
  },
  { __kind: "TransferHook", authority: AUTHORITY, programId: UNSET },
  { __kind: "PermanentDelegate", delegate: AUTHORITY },
  {
    __kind: "ConfidentialTransferMint",
    authority: AUTHORITY,
    autoApproveNewAccounts: false,
    auditorElgamalPubkey: null,
  },
  { __kind: "MintCloseAuthority", closeAuthority: AUTHORITY },
];

const CAPABILITY_EXTENSIONS = [
  "NonTransferable",
  "PausableConfig",
  "DefaultAccountState",
  "TransferFeeConfig",
  "ScaledUiAmountConfig",
  "InterestBearingConfig",
  "TransferHook",
] as const satisfies readonly CapabilityExtension[];

/** One probe mint per extension a row decides, in a state the builder must move; null when none. */
const MOVABLE_PROBES: Record<CapabilityExtension, ExtensionArgs[] | null> = {
  NonTransferable: null,
  PausableConfig: [{ __kind: "PausableConfig", authority: AUTHORITY, paused: false }],
  DefaultAccountState: [{ __kind: "DefaultAccountState", state: AccountState.Initialized }],
  TransferFeeConfig: [
    {
      __kind: "TransferFeeConfig",
      transferFeeConfigAuthority: AUTHORITY,
      withdrawWithheldAuthority: AUTHORITY,
      withheldAmount: 0n,
      olderTransferFee: { epoch: 0n, maximumFee: 5_000n, transferFeeBasisPoints: 50 },
      newerTransferFee: { epoch: 0n, maximumFee: 5_000n, transferFeeBasisPoints: 50 },
    },
  ],
  // The builder refuses both until PR 5 (`scaled_display`), so Kora may block them for now.
  ScaledUiAmountConfig: null,
  InterestBearingConfig: null,
  TransferHook: [{ __kind: "TransferHook", authority: AUTHORITY, programId: HOOK_PROGRAM }],
};

describe("the builder's capability row agrees with the Kora sponsor policy", () => {
  const allowedTokens = tomlStringArray("allowed_tokens");
  const blockedMintExtensions = tomlStringArray("blocked_mint_extensions");
  const blockedAccountExtensions = tomlStringArray("blocked_account_extensions");

  it("parsed a non-trivial allowed_tokens list", () => {
    // Guards the guard: an empty parse would make the per-token checks vacuous.
    expect(allowedTokens.length).toBeGreaterThan(2);
  });

  it.each(allowedTokens)("moves allowed token %s through the builder", (mint) => {
    const token = WELL_KNOWN_TOKEN_BY_MINT.get(mint);
    if (token === undefined) {
      throw new Error(`${mint} in ${HARNESS_CONFIG} is not a catalogue mint`);
    }
    const terms =
      token.tokenProgram === "token-2022"
        ? mintTerms(address(mint), "token-2022", PAXOS_STABLECOIN_EXTENSIONS)
        : mintTerms(address(mint), "spl-token", null);
    expect(support(terms, "builder")).toEqual({ supported: true });
  });

  it("names only extensions this test knows how Kora spells", () => {
    expect(blockedMintExtensions.filter((name) => !KNOWN_KORA_MINT_EXTENSIONS.has(name))).toEqual(
      []
    );
    expect(
      blockedAccountExtensions.filter((name) => !KNOWN_KORA_ACCOUNT_EXTENSIONS.has(name))
    ).toEqual([]);
  });

  it.each(CAPABILITY_EXTENSIONS)("Kora sponsors %s whenever the builder moves it", (extension) => {
    const extensions = MOVABLE_PROBES[extension];
    if (extensions === null) {
      // The builder refuses this extension in every state.
      return;
    }
    const name = KORA_MINT_EXTENSION_NAMES[extension];
    expect(support(mintTerms(testAddress(9), "token-2022", extensions), "builder")).toEqual({
      supported: true,
    });
    expect(blockedMintExtensions).not.toContain(name);
  });

  it("refuses every state of a non-transferable mint, which Kora may block freely", () => {
    const decision = support(
      mintTerms(testAddress(9), "token-2022", [{ __kind: "NonTransferable" }]),
      "builder"
    );
    expect(decision.supported).toBe(false);
  });

  it("blocks none of the passive mint extensions PYUSD and USDG carry", () => {
    for (const name of Object.values(KORA_PASSIVE_MINT_EXTENSION_NAMES)) {
      expect(blockedMintExtensions).not.toContain(name);
    }
  });

  it("blocks no account extension a builder movement creates or meets", () => {
    for (const name of KORA_ACCOUNT_EXTENSION_NAMES) {
      expect(blockedAccountExtensions).not.toContain(name);
    }
  });

  it("allows hook mints: allow_all wherever the harness sets a policy, and stated for deployed configs", () => {
    const policy = transferHookPolicy();
    if (policy !== undefined) {
      expect(policy).toBe("allow_all");
    }
    expect(CONFIG).toMatch(/set `transfer_hook_policy = "allow_all"` explicitly/);
  });
});
