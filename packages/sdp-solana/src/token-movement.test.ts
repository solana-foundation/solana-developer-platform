import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TOKEN_MOVEMENT_PATHS, type TokenMovementPath } from "@sdp/types/token-movements";
import { MEMO_PROGRAM_ADDRESS } from "@sdp/types/well-known-programs";
import { SPL_TOKEN_PROGRAMS } from "@sdp/types/well-known-tokens";
import {
  AccountRole,
  type Address,
  address,
  createNoopSigner,
  createSolanaRpcFromTransport,
  type EncodedAccount,
  getAddressDecoder,
  getAddressEncoder,
  getBase64Decoder,
  getProgramDerivedAddress,
  lamports,
  type MaybeEncodedAccount,
  type ReadonlyUint8Array,
  type RpcTransport,
  unixTimestamp,
} from "@solana/kit";
import { getSysvarClockEncoder, SYSVAR_CLOCK_ADDRESS } from "@solana/sysvars";
import {
  findFlagAccountPda,
  findMintConfigPda,
  findThawExtraMetasAccountPda,
  getMintConfigEncoder,
  getThawPermissionlessIdempotentInstructionDataEncoder,
  TOKEN_ACL_PROGRAM_ADDRESS,
} from "@solana/token-acl-sdk";
import {
  getTransferSolInstructionDataDecoder,
  SYSTEM_PROGRAM_ADDRESS,
} from "@solana-program/system";
import {
  AccountState,
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  type ExtensionArgs,
  type ExtraAccountMeta,
  findExtraAccountMetaListPda,
  getExtraAccountMetasEncoder,
  getMintEncoder,
  getTokenEncoder,
  getTokenSize,
  getTransferCheckedInstructionDataDecoder,
  getTransferCheckedWithFeeInstructionDataDecoder,
  resolveExtraAccountMetasForExecute,
} from "@solana-program/token-2022";
import { quoteMovement } from "./movement-quote";
import { baseUnits, parseTokenAmount } from "./token-amount";
import {
  assertMovementBuildable,
  associatedTokenAccountSize,
  buildTokenMovement,
  capabilityRefusals,
  type DestinationTokenAccount,
  decodeDestinationTokenAccount,
  recurringPullFee,
  recurringPullSupport,
  resolveTokenAclThaws,
  resolveTransferHookAccounts,
  support,
  TOKEN_MOVEMENT_REFUSALS,
  type TokenMovementAccounts,
  type TokenMovementContext,
  TokenMovementError,
  type TokenMovementRefusal,
} from "./token-movement";
import {
  decodeTokenTerms,
  type MintTokenTerms,
  NATIVE_TOKEN_TERMS,
  type TokenTerms,
} from "./token-terms";

const testAddress = (byte: number): Address =>
  getAddressDecoder().decode(new Uint8Array(32).fill(byte));

const MINT = testAddress(1);
const AUTHORITY = testAddress(2);
const HOOK_PROGRAM = testAddress(3);
const SOURCE = testAddress(4);
const OWNER = testAddress(5);
const DESTINATION_ACCOUNT = testAddress(6);
const RENT_PAYER = testAddress(7);
const REFERENCE = testAddress(8);
const HOOK_STATE = testAddress(9);
const SPL_TOKEN = address(SPL_TOKEN_PROGRAMS["spl-token"]);
const TOKEN_2022 = address(SPL_TOKEN_PROGRAMS["token-2022"]);
const SIGNER = createNoopSigner(SOURCE);

function account(at: Address, programAddress: Address, data: ReadonlyUint8Array): EncodedAccount {
  return {
    address: at,
    data,
    executable: false,
    lamports: lamports(1n),
    programAddress,
    space: 0n,
  };
}

const CLOCK = account(
  SYSVAR_CLOCK_ADDRESS,
  address("Sysvar1111111111111111111111111111111111111"),
  getSysvarClockEncoder().encode({
    slot: 900n,
    epochStartTimestamp: unixTimestamp(1_799_990_000n),
    epoch: 700n,
    leaderScheduleEpoch: 701n,
    unixTimestamp: unixTimestamp(1_800_000_000n),
  })
);

function mintTerms(
  program: Address,
  extensions: ExtensionArgs[] | null,
  freezeAuthority: Address | null
): MintTokenTerms {
  const mint = getMintEncoder().encode({
    mintAuthority: AUTHORITY,
    supply: 1_000_000n,
    decimals: 6,
    isInitialized: true,
    freezeAuthority,
    extensions,
  });
  return decodeTokenTerms(
    { kind: "mint", mint: MINT },
    { mint: account(MINT, program, mint), clock: CLOCK }
  );
}

function terms(program: Address, extensions: ExtensionArgs[] | null): MintTokenTerms {
  return mintTerms(program, extensions, AUTHORITY);
}

const fee = (basisPoints: number, maximumFee: bigint): ExtensionArgs => {
  const rate = { epoch: 0n, maximumFee, transferFeeBasisPoints: basisPoints };
  return {
    __kind: "TransferFeeConfig",
    transferFeeConfigAuthority: AUTHORITY,
    withdrawWithheldAuthority: AUTHORITY,
    withheldAmount: 0n,
    olderTransferFee: rate,
    newerTransferFee: rate,
  };
};

const CLASSIC = terms(SPL_TOKEN, null);
const FEE_ZERO = terms(TOKEN_2022, [fee(0, 0n)]);
const FEE_CAPPED = terms(TOKEN_2022, [fee(50, 5_000n)]);
const HOOKED = terms(TOKEN_2022, [
  { __kind: "TransferHook", authority: AUTHORITY, programId: HOOK_PROGRAM },
]);

function debit(on: TokenTerms, amount: string) {
  return quoteMovement(on, {
    asset: on.asset,
    amount: parseTokenAmount(amount, on.decimals),
    basis: "debit",
  });
}

function credit(on: TokenTerms, amount: string) {
  return quoteMovement(on, {
    asset: on.asset,
    amount: parseTokenAmount(amount, on.decimals),
    basis: "credit",
  });
}

const DESTINATION: DestinationTokenAccount = {
  owner: OWNER,
  tokenAccount: DESTINATION_ACCOUNT,
  exists: true,
  requiresMemo: false,
  frozen: false,
};

type TokenAccounts = Extract<TokenMovementAccounts, { kind: "token" }>;

const TOKEN_ACCOUNTS: TokenAccounts = {
  kind: "token",
  source: SOURCE,
  destination: DESTINATION,
  hookAccounts: [],
  thaw: null,
};

/** A token movement's context: the shared accounts with `accounts` and `extra` applied. */
function tokenContext(
  accounts: Partial<Pick<TokenAccounts, "destination" | "hookAccounts" | "thaw">>,
  extra: Partial<Pick<TokenMovementContext, "memo" | "reference">>
): TokenMovementContext {
  return {
    authority: SIGNER,
    rentPayer: createNoopSigner(RENT_PAYER),
    memo: null,
    reference: null,
    ...extra,
    accounts: { ...TOKEN_ACCOUNTS, ...accounts },
  };
}

function refusal(reason: string) {
  return (error: unknown) => error instanceof TokenMovementError && error.reason === reason;
}

describe("support", () => {
  it("moves native SOL, classic and fee mints through the builder", () => {
    for (const movable of [NATIVE_TOKEN_TERMS, CLASSIC, FEE_ZERO, FEE_CAPPED, HOOKED]) {
      assert.deepEqual(support(movable, "builder"), { supported: true });
    }
  });

  it("refuses a non-transferable or paused mint, and a frozen-by-default one nothing can thaw", () => {
    const frozen: ExtensionArgs = { __kind: "DefaultAccountState", state: AccountState.Frozen };
    const cases: [MintTokenTerms, string][] = [
      [terms(TOKEN_2022, [{ __kind: "NonTransferable" }]), TOKEN_MOVEMENT_REFUSALS.nonTransferable],
      [
        terms(TOKEN_2022, [{ __kind: "PausableConfig", authority: AUTHORITY, paused: true }]),
        "paused",
      ],
      [mintTerms(TOKEN_2022, [frozen], null), "default_frozen"],
    ];
    for (const [refusedTerms, reason] of cases) {
      const decision = support(refusedTerms, "builder");
      assert.equal(decision.supported, false);
      assert.equal(decision.supported === false && decision.refusal, reason);
    }
  });

  it("moves a frozen-by-default mint with a freeze authority: the thaw is decided per destination", () => {
    const frozen: ExtensionArgs = { __kind: "DefaultAccountState", state: AccountState.Frozen };
    assert.deepEqual(support(terms(TOKEN_2022, [frozen]), "builder"), { supported: true });
  });

  it("moves a pausable mint that is not paused", () => {
    const pausable = terms(TOKEN_2022, [
      { __kind: "PausableConfig", authority: AUTHORITY, paused: false },
    ]);
    assert.deepEqual(support(pausable, "builder"), { supported: true });
  });
});

describe("recurring support (ADR 0012)", () => {
  const PULL = { debit: baseUnits(1_000_000n), maxFeePerPull: baseUnits(0n) };

  it("moves classic, fee and hook mints, and holds a paused mint instead of refusing it", () => {
    for (const movable of [CLASSIC, FEE_ZERO, FEE_CAPPED, HOOKED]) {
      assert.deepEqual(support(movable, "recurring"), { supported: true });
    }
    const paused = support(
      terms(TOKEN_2022, [{ __kind: "PausableConfig", authority: AUTHORITY, paused: true }]),
      "recurring"
    );
    assert.equal(paused.supported === false && paused.disposition, "hold");
    assert.equal(paused.supported === false && paused.refusal, "paused");
    const builderPaused = support(
      terms(TOKEN_2022, [{ __kind: "PausableConfig", authority: AUTHORITY, paused: true }]),
      "builder"
    );
    assert.equal(builderPaused.supported === false && builderPaused.disposition, "refuse");
  });

  it("refuses a non-transferable or frozen-by-default mint", () => {
    for (const extensions of [
      [{ __kind: "NonTransferable" }],
      [{ __kind: "DefaultAccountState", state: AccountState.Frozen }],
    ] satisfies ExtensionArgs[][]) {
      const decision = support(terms(TOKEN_2022, extensions), "recurring");
      assert.equal(decision.supported === false && decision.disposition, "refuse");
    }
  });

  it("holds a pull to a frozen destination until its freeze authority thaws it", () => {
    const decision = recurringPullSupport(CLASSIC, PULL, { ...DESTINATION, frozen: true });
    assert.equal(decision.supported === false && decision.refusal, "destination_frozen");
    assert.equal(decision.supported === false && decision.disposition, "hold");
  });

  it("holds a pull to a destination that requires memos, which a CPI cannot send", () => {
    const decision = recurringPullSupport(CLASSIC, PULL, { ...DESTINATION, requiresMemo: true });
    assert.equal(decision.supported === false && decision.refusal, "memo_required");
    assert.equal(decision.supported === false && decision.disposition, "hold");
  });

  it("holds a pull whose fee is above the mandate's tolerance, and makes one within it", () => {
    // 50 bps of 1 token is 0.005, under the 0.005 cap.
    assert.equal(recurringPullFee(FEE_CAPPED, PULL.debit), 5_000n);
    const held = recurringPullSupport(FEE_CAPPED, PULL, DESTINATION);
    assert.equal(held.supported === false && held.refusal, "fee_above_tolerance");
    assert.deepEqual(
      recurringPullSupport(FEE_CAPPED, { ...PULL, maxFeePerPull: baseUnits(5_000n) }, DESTINATION),
      { supported: true }
    );
    assert.deepEqual(recurringPullSupport(FEE_ZERO, PULL, DESTINATION), { supported: true });
  });

  it("prices the fee at the larger of this epoch's and the next epoch's entry", () => {
    // The newer entry, 100 bps, takes effect in the epoch after the read (epoch 700).
    const rising = terms(TOKEN_2022, [
      {
        __kind: "TransferFeeConfig",
        transferFeeConfigAuthority: AUTHORITY,
        withdrawWithheldAuthority: AUTHORITY,
        withheldAmount: 0n,
        olderTransferFee: { epoch: 0n, maximumFee: 0n, transferFeeBasisPoints: 0 },
        newerTransferFee: { epoch: 701n, maximumFee: 1_000_000n, transferFeeBasisPoints: 100 },
      },
    ]);
    assert.equal(recurringPullFee(rising, PULL.debit), 10_000n);
    const held = recurringPullSupport(rising, PULL, DESTINATION);
    assert.equal(held.supported === false && held.refusal, "fee_above_tolerance");
  });
});

describe("the capability table", () => {
  const UNSET = address("11111111111111111111111111111111");
  const charging = (current: number, newer: number): ExtensionArgs => ({
    __kind: "TransferFeeConfig",
    transferFeeConfigAuthority: AUTHORITY,
    withdrawWithheldAuthority: AUTHORITY,
    withheldAmount: 0n,
    olderTransferFee: { epoch: 0n, maximumFee: 5_000n, transferFeeBasisPoints: current },
    // The newer entry applies from epoch 701; the read is at 700.
    newerTransferFee: { epoch: 701n, maximumFee: 5_000n, transferFeeBasisPoints: newer },
  });
  const scaled: ExtensionArgs = {
    __kind: "ScaledUiAmountConfig",
    authority: AUTHORITY,
    multiplier: 1.5,
    newMultiplierEffectiveTimestamp: 0n,
    newMultiplier: 1.5,
  };
  const interest: ExtensionArgs = {
    __kind: "InterestBearingConfig",
    rateAuthority: AUTHORITY,
    initializationTimestamp: 1_700_000_000n,
    preUpdateAverageRate: 500,
    lastUpdateTimestamp: 1_700_000_000n,
    currentRate: 500,
  };
  const hook = (authority: Address, programId: Address): ExtensionArgs => ({
    __kind: "TransferHook",
    authority,
    programId,
  });

  /** Each mint state, and what each path refuses under it, in the row's order. */
  const STATES: readonly [
    string,
    TokenTerms,
    Record<TokenMovementPath, readonly TokenMovementRefusal[]>,
  ][] = [
    [
      "native SOL",
      NATIVE_TOKEN_TERMS,
      {
        builder: [],
        recurring: [],
        issuance: [],
        issuance_seize: [],
        dvp: [],
        private_channels: [],
        earn: [],
      },
    ],
    [
      "classic",
      CLASSIC,
      {
        builder: [],
        recurring: [],
        issuance: [],
        issuance_seize: [],
        dvp: [],
        private_channels: [],
        earn: [],
      },
    ],
    [
      "fee config at 0 bps",
      FEE_ZERO,
      {
        builder: [],
        recurring: [],
        issuance: [],
        issuance_seize: [],
        dvp: ["transfer_fee"],
        private_channels: ["transfer_fee"],
        earn: [],
      },
    ],
    [
      "fee charged now",
      terms(TOKEN_2022, [charging(50, 50)]),
      {
        builder: [],
        recurring: [],
        issuance: [],
        issuance_seize: [],
        dvp: ["transfer_fee"],
        private_channels: ["transfer_fee"],
        earn: ["transfer_fee"],
      },
    ],
    [
      "fee set to be charged from the next epoch",
      terms(TOKEN_2022, [charging(0, 50)]),
      {
        builder: [],
        recurring: [],
        issuance: [],
        issuance_seize: [],
        dvp: ["transfer_fee"],
        private_channels: ["transfer_fee"],
        earn: ["transfer_fee"],
      },
    ],
    [
      "scaled UI amount",
      terms(TOKEN_2022, [scaled]),
      {
        builder: ["scaled_display"],
        recurring: ["scaled_display"],
        issuance: [],
        issuance_seize: [],
        dvp: ["display_rule"],
        private_channels: [],
        earn: [],
      },
    ],
    [
      "interest-bearing",
      terms(TOKEN_2022, [interest]),
      {
        builder: ["scaled_display"],
        recurring: ["scaled_display"],
        issuance: [],
        issuance_seize: [],
        dvp: ["display_rule"],
        private_channels: [],
        earn: [],
      },
    ],
    [
      "hook program set",
      HOOKED,
      {
        builder: [],
        recurring: [],
        issuance: [],
        issuance_seize: ["transfer_hook"],
        dvp: ["transfer_hook"],
        private_channels: ["transfer_hook"],
        earn: ["transfer_hook"],
      },
    ],
    [
      "no hook program, a mutable hook authority (PYUSD, USDG)",
      terms(TOKEN_2022, [hook(AUTHORITY, UNSET)]),
      {
        builder: [],
        recurring: [],
        issuance: [],
        issuance_seize: [],
        dvp: ["transfer_hook"],
        private_channels: ["transfer_hook"],
        earn: [],
      },
    ],
    [
      "an immutable hook with no program",
      terms(TOKEN_2022, [hook(UNSET, UNSET)]),
      {
        builder: [],
        recurring: [],
        issuance: [],
        issuance_seize: [],
        dvp: [],
        private_channels: [],
        earn: [],
      },
    ],
    [
      "paused",
      terms(TOKEN_2022, [{ __kind: "PausableConfig", authority: AUTHORITY, paused: true }]),
      {
        builder: ["paused"],
        recurring: ["paused"],
        issuance: ["paused"],
        issuance_seize: ["paused"],
        dvp: ["paused"],
        private_channels: ["paused"],
        earn: ["paused"],
      },
    ],
    [
      "pausable, not paused",
      terms(TOKEN_2022, [{ __kind: "PausableConfig", authority: AUTHORITY, paused: false }]),
      {
        builder: [],
        recurring: [],
        issuance: [],
        issuance_seize: [],
        dvp: [],
        private_channels: [],
        earn: [],
      },
    ],
    [
      "non-transferable",
      terms(TOKEN_2022, [{ __kind: "NonTransferable" }]),
      {
        builder: ["non_transferable"],
        recurring: ["non_transferable"],
        issuance: [],
        issuance_seize: ["non_transferable"],
        dvp: ["non_transferable"],
        private_channels: ["non_transferable"],
        earn: ["non_transferable"],
      },
    ],
    [
      "frozen by default, with a freeze authority",
      terms(TOKEN_2022, [{ __kind: "DefaultAccountState", state: AccountState.Frozen }]),
      {
        builder: [],
        // The subscriptions program's CPI cannot thaw an account.
        recurring: ["default_frozen"],
        issuance: [],
        issuance_seize: [],
        dvp: [],
        private_channels: ["default_frozen"],
        earn: ["default_frozen"],
      },
    ],
    [
      "frozen by default, with no freeze authority",
      mintTerms(TOKEN_2022, [{ __kind: "DefaultAccountState", state: AccountState.Frozen }], null),
      {
        builder: ["default_frozen"],
        recurring: ["default_frozen"],
        issuance: [],
        issuance_seize: [],
        dvp: [],
        private_channels: ["default_frozen"],
        earn: ["default_frozen"],
      },
    ],
    [
      "permanent delegate, confidential transfers and a close authority",
      terms(TOKEN_2022, [
        { __kind: "PermanentDelegate", delegate: AUTHORITY },
        {
          __kind: "ConfidentialTransferMint",
          authority: AUTHORITY,
          autoApproveNewAccounts: false,
          auditorElgamalPubkey: null,
        },
        { __kind: "MintCloseAuthority", closeAuthority: AUTHORITY },
      ]),
      {
        builder: [],
        recurring: [],
        issuance: [],
        issuance_seize: [],
        dvp: [],
        private_channels: [],
        earn: [],
      },
    ],
    [
      "a fee config, a mutable hook and paused at once, in the row's order",
      terms(TOKEN_2022, [
        fee(0, 0n),
        hook(AUTHORITY, HOOK_PROGRAM),
        { __kind: "PausableConfig", authority: AUTHORITY, paused: true },
      ]),
      {
        builder: ["paused"],
        recurring: ["paused"],
        issuance: ["paused"],
        issuance_seize: ["paused", "transfer_hook"],
        dvp: ["transfer_fee", "transfer_hook", "paused"],
        private_channels: ["paused", "transfer_fee", "transfer_hook"],
        earn: ["paused", "transfer_hook"],
      },
    ],
  ];

  it("has a row for every path, and every state is decided on every path", () => {
    for (const [label, stateTerms, expected] of STATES) {
      assert.deepEqual(Object.keys(expected).sort(), [...TOKEN_MOVEMENT_PATHS].sort(), label);
      for (const path of TOKEN_MOVEMENT_PATHS) {
        const refusals = capabilityRefusals(stateTerms, path);
        assert.deepEqual(
          refusals.map((refusal) => refusal.refusal),
          expected[path],
          `${label} on ${path}`
        );
        // Every refusal is a `refuse`, except the recurring row's paused mint.
        assert.deepEqual(
          refusals.map((refusal) => refusal.disposition),
          expected[path].map((reason) =>
            path === "recurring" && reason === "paused" ? "hold" : "refuse"
          ),
          `${label} on ${path}`
        );
        const [first] = refusals;
        assert.deepEqual(
          support(stateTerms, path),
          first === undefined
            ? { supported: true }
            : {
                supported: false,
                refusal: first.refusal,
                message: first.message,
                disposition: first.disposition,
              },
          `${label} on ${path}`
        );
      }
    }
  });

  it("names the extension each refusal comes from", () => {
    const refusals = capabilityRefusals(
      terms(TOKEN_2022, [
        fee(0, 0n),
        interest,
        hook(AUTHORITY, UNSET),
        { __kind: "NonTransferable" },
      ]),
      "dvp"
    );
    assert.deepEqual(
      refusals.map((refusal) => refusal.extension),
      ["TransferFeeConfig", "InterestBearingConfig", "NonTransferable", "TransferHook"]
    );
  });
});

describe("buildTokenMovement", () => {
  it("moves native SOL with one system transfer of the debit, the reference last", () => {
    const solQuote = debit(NATIVE_TOKEN_TERMS, "1.5");
    const [transfer, ...rest] = buildTokenMovement(NATIVE_TOKEN_TERMS, solQuote, {
      authority: SIGNER,
      rentPayer: createNoopSigner(RENT_PAYER),
      accounts: { kind: "native", destination: OWNER },
      memo: null,
      reference: REFERENCE,
    });
    assert.equal(rest.length, 0);
    assert.equal(transfer.programAddress, SYSTEM_PROGRAM_ADDRESS);
    assert.equal(
      getTransferSolInstructionDataDecoder().decode(transfer.data ?? new Uint8Array()).amount,
      1_500_000_000n
    );
    assert.deepEqual(transfer.accounts?.at(-1), { address: REFERENCE, role: AccountRole.READONLY });
  });

  it("builds TransferChecked under a classic mint's program, after the destination's create", () => {
    const [create, transfer, ...rest] = buildTokenMovement(
      CLASSIC,
      debit(CLASSIC, "2.5"),
      tokenContext({}, {})
    );
    assert.equal(rest.length, 0);
    assert.deepEqual(create.accounts?.map((meta) => meta.address).slice(0, 4), [
      RENT_PAYER,
      DESTINATION_ACCOUNT,
      OWNER,
      MINT,
    ]);
    assert.equal(transfer.programAddress, SPL_TOKEN);
    const data = getTransferCheckedInstructionDataDecoder().decode(
      transfer.data ?? new Uint8Array()
    );
    assert.equal(data.amount, 2_500_000n);
    assert.equal(data.decimals, 6);
    assert.deepEqual(
      transfer.accounts?.map((meta) => meta.address),
      [SOURCE, MINT, DESTINATION_ACCOUNT, SOURCE]
    );
  });

  it("names the fee with TransferCheckedWithFee whenever the mint has a fee config, even at 0 bps", () => {
    for (const [feeTerms, amount, expectedFee] of [
      [FEE_ZERO, "1", 0n],
      [FEE_CAPPED, "1", 5_000n],
      [FEE_CAPPED, "0.333333", 1_667n],
    ] as const) {
      const priced = debit(feeTerms, amount);
      const [, transfer] = buildTokenMovement(feeTerms, priced, tokenContext({}, {}));
      assert.equal(transfer.programAddress, TOKEN_2022);
      const data = getTransferCheckedWithFeeInstructionDataDecoder().decode(
        transfer.data ?? new Uint8Array()
      );
      assert.equal(data.amount, priced.debit);
      assert.equal(data.fee, expectedFee);
      assert.equal(data.fee, priced.fee);
    }
  });

  it("debits the grossed-up amount for a credit quote", () => {
    const priced = credit(FEE_CAPPED, "0.995");
    const [, transfer] = buildTokenMovement(FEE_CAPPED, priced, tokenContext({}, {}));
    const data = getTransferCheckedWithFeeInstructionDataDecoder().decode(
      transfer.data ?? new Uint8Array()
    );
    assert.equal(data.amount, 1_000_000n);
    assert.equal(data.fee, 5_000n);
  });

  it("puts the memo directly before the transfer when the destination requires memos", () => {
    const instructions = buildTokenMovement(
      CLASSIC,
      debit(CLASSIC, "1"),
      tokenContext({ destination: { ...DESTINATION, requiresMemo: true } }, { memo: "invoice 42" })
    );
    assert.equal(instructions.length, 3);
    assert.equal(instructions[1].programAddress, MEMO_PROGRAM_ADDRESS);
    assert.deepEqual(instructions[1].data, new TextEncoder().encode("invoice 42"));
    assert.equal(instructions[2].programAddress, SPL_TOKEN);
  });

  it("sends no memo to a destination that does not require one", () => {
    const instructions = buildTokenMovement(
      CLASSIC,
      debit(CLASSIC, "1"),
      tokenContext({}, { memo: "invoice 42" })
    );
    assert.equal(instructions.length, 2);
  });

  it("refuses a memo-required destination without a memo", () => {
    assert.throws(
      () =>
        buildTokenMovement(
          CLASSIC,
          debit(CLASSIC, "1"),
          tokenContext({ destination: { ...DESTINATION, requiresMemo: true } }, {})
        ),
      refusal(TOKEN_MOVEMENT_REFUSALS.memoRequired)
    );
  });

  it("appends the hook accounts to the transfer, then the reference", () => {
    const hookAccounts = [
      { address: HOOK_STATE, role: AccountRole.WRITABLE },
      { address: HOOK_PROGRAM, role: AccountRole.READONLY },
    ];
    const [, transfer] = buildTokenMovement(
      HOOKED,
      debit(HOOKED, "1"),
      tokenContext({ hookAccounts }, { reference: REFERENCE })
    );
    assert.deepEqual(transfer.accounts?.slice(4), [
      ...hookAccounts,
      { address: REFERENCE, role: AccountRole.READONLY },
    ]);
  });

  it("refuses a hook mint whose accounts were not resolved", () => {
    assert.throws(
      () => buildTokenMovement(HOOKED, debit(HOOKED, "1"), tokenContext({}, {})),
      refusal(TOKEN_MOVEMENT_REFUSALS.hookUnresolved)
    );
  });

  it("refuses a quote whose fee takes the whole amount", () => {
    assert.throws(
      () => buildTokenMovement(FEE_CAPPED, debit(FEE_CAPPED, "0.000001"), tokenContext({}, {})),
      refusal(TOKEN_MOVEMENT_REFUSALS.nothingCredited)
    );
  });

  it("refuses the capability row's refusals at build time too", () => {
    const paused = terms(TOKEN_2022, [
      { __kind: "PausableConfig", authority: AUTHORITY, paused: true },
    ]);
    assert.throws(
      () => buildTokenMovement(paused, debit(paused, "1"), tokenContext({}, {})),
      refusal(TOKEN_MOVEMENT_REFUSALS.paused)
    );
  });

  it("fails loudly on accounts of another kind than the terms", () => {
    assert.throws(() =>
      assertMovementBuildable(NATIVE_TOKEN_TERMS, debit(NATIVE_TOKEN_TERMS, "1"), {
        accounts: TOKEN_ACCOUNTS,
        memo: null,
      })
    );
    assert.throws(() =>
      assertMovementBuildable(CLASSIC, debit(CLASSIC, "1"), {
        accounts: { kind: "native", destination: OWNER },
        memo: null,
      })
    );
    assert.throws(() =>
      assertMovementBuildable(FEE_ZERO, debit(CLASSIC, "1"), {
        accounts: TOKEN_ACCOUNTS,
        memo: null,
      })
    );
  });
});

describe("associatedTokenAccountSize", () => {
  it("sizes a classic account plainly and a Token-2022 one with its extensions", () => {
    assert.equal(associatedTokenAccountSize(CLASSIC), getTokenSize());
    assert.equal(
      associatedTokenAccountSize(FEE_ZERO),
      getTokenSize([
        { __kind: "ImmutableOwner" },
        { __kind: "TransferFeeAmount", withheldAmount: 0n },
      ])
    );
  });

  it("counts ImmutableOwner once for a non-transferable mint", () => {
    const nonTransferable = terms(TOKEN_2022, [{ __kind: "NonTransferable" }]);
    assert.equal(
      associatedTokenAccountSize(nonTransferable),
      getTokenSize([{ __kind: "ImmutableOwner" }, { __kind: "NonTransferableAccount" }])
    );
  });
});

describe("decodeDestinationTokenAccount", () => {
  /** An existing Token-2022 account of `mint` that OWNER owns, as a read returns it. */
  function tokenAccount(extensions: ExtensionArgs[] | null, mint: Address): MaybeEncodedAccount {
    const read = account(
      DESTINATION_ACCOUNT,
      TOKEN_2022,
      getTokenEncoder().encode({
        mint,
        owner: OWNER,
        amount: 0n,
        delegate: null,
        state: AccountState.Initialized,
        isNative: null,
        delegatedAmount: 0n,
        closeAuthority: null,
        extensions,
      })
    );
    return { ...read, data: new Uint8Array(read.data), exists: true };
  }

  it("reads a missing account as one the movement creates, with no memo rule", () => {
    assert.deepEqual(
      decodeDestinationTokenAccount(FEE_ZERO, OWNER, DESTINATION_ACCOUNT, {
        address: DESTINATION_ACCOUNT,
        exists: false,
      }),
      {
        owner: OWNER,
        tokenAccount: DESTINATION_ACCOUNT,
        exists: false,
        requiresMemo: false,
        frozen: false,
      }
    );
  });

  it("reads lamports sent to the unopened address as a missing account", () => {
    const prefunded = account(DESTINATION_ACCOUNT, SYSTEM_PROGRAM_ADDRESS, new Uint8Array());
    assert.deepEqual(
      decodeDestinationTokenAccount(FEE_ZERO, OWNER, DESTINATION_ACCOUNT, {
        ...prefunded,
        data: new Uint8Array(prefunded.data),
        exists: true,
      }),
      {
        owner: OWNER,
        tokenAccount: DESTINATION_ACCOUNT,
        exists: false,
        requiresMemo: false,
        frozen: false,
      }
    );
  });

  it("reads whether an existing account is frozen", () => {
    for (const state of [AccountState.Frozen, AccountState.Initialized]) {
      const read = account(
        DESTINATION_ACCOUNT,
        TOKEN_2022,
        getTokenEncoder().encode({
          mint: MINT,
          owner: OWNER,
          amount: 0n,
          delegate: null,
          state,
          isNative: null,
          delegatedAmount: 0n,
          closeAuthority: null,
          extensions: null,
        })
      );
      const decoded = decodeDestinationTokenAccount(FEE_ZERO, OWNER, DESTINATION_ACCOUNT, {
        ...read,
        data: new Uint8Array(read.data),
        exists: true,
      });
      assert.equal(decoded.frozen, state === AccountState.Frozen);
    }
  });

  it("reads the MemoTransfer extension", () => {
    for (const requireIncomingTransferMemos of [true, false]) {
      const decoded = decodeDestinationTokenAccount(
        FEE_ZERO,
        OWNER,
        DESTINATION_ACCOUNT,
        tokenAccount(
          [{ __kind: "ImmutableOwner" }, { __kind: "MemoTransfer", requireIncomingTransferMemos }],
          MINT
        )
      );
      assert.equal(decoded.exists, true);
      assert.equal(decoded.requiresMemo, requireIncomingTransferMemos);
    }
  });

  it("fails loudly on an account of another mint or address", () => {
    assert.throws(() =>
      decodeDestinationTokenAccount(
        FEE_ZERO,
        OWNER,
        DESTINATION_ACCOUNT,
        tokenAccount(null, testAddress(11))
      )
    );
    assert.throws(() =>
      decodeDestinationTokenAccount(FEE_ZERO, OWNER, testAddress(12), tokenAccount(null, MINT))
    );
  });
});

type StoredAccount = { owner: Address; data: ReadonlyUint8Array };

/** An RPC that answers `getAccountInfo` from `accounts` and records each address it read. */
function stubRpc(accounts: ReadonlyMap<Address, StoredAccount>) {
  const reads: string[] = [];
  const transport: RpcTransport = async <TResponse>({ payload }: Parameters<RpcTransport>[0]) => {
    // SAFETY: kit sends a JSON-RPC request; a getAccountInfo request names its address first.
    const request = payload as { id: string; method: string; params: [Address, unknown] };
    assert.equal(request.method, "getAccountInfo");
    const [at] = request.params;
    reads.push(at);
    const stored = accounts.get(at);
    const value =
      stored === undefined
        ? null
        : {
            data: [getBase64Decoder().decode(stored.data), "base64"],
            executable: false,
            lamports: 1,
            owner: stored.owner,
            rentEpoch: 0,
            space: stored.data.length,
          };
    // SAFETY: the transport returns the JSON-RPC response body kit asked for.
    return {
      jsonrpc: "2.0",
      id: request.id,
      result: { context: { slot: 1 }, value },
    } as TResponse;
  };
  return { rpc: createSolanaRpcFromTransport(transport), reads };
}

describe("resolveTransferHookAccounts", () => {
  const transfer = (destination: Address) => ({
    source: SOURCE,
    destination,
    owner: AUTHORITY,
    amount: debit(HOOKED, "1").debit,
  });

  /** One literal account, one PDA of the hook seeded by the destination, one seeded by the amount. */
  const EXTRA_METAS: ExtraAccountMeta[] = [
    { config: { __kind: "Literal", address: HOOK_STATE }, isSigner: false, isWritable: true },
    {
      config: {
        __kind: "ProgramPda",
        seeds: [
          { __kind: "Literal", bytes: new TextEncoder().encode("kyc") },
          { __kind: "AccountKey", index: 2 },
        ],
      },
      isSigner: false,
      isWritable: false,
    },
    {
      config: {
        __kind: "ProgramPda",
        seeds: [{ __kind: "InstructionData", index: 0, length: 16 }],
      },
      isSigner: false,
      isWritable: false,
    },
  ];

  async function validationAccounts(metas: ExtraAccountMeta[]) {
    const [validation] = await findExtraAccountMetaListPda(
      { mint: MINT },
      { programAddress: HOOK_PROGRAM }
    );
    const accounts = new Map<Address, StoredAccount>([
      [validation, { owner: HOOK_PROGRAM, data: getExtraAccountMetasEncoder().encode(metas) }],
    ]);
    return { validation, accounts };
  }

  it("reads nothing for a mint without a hook program", async () => {
    const { rpc, reads } = stubRpc(new Map());
    assert.deepEqual(
      await resolveTransferHookAccounts(rpc, FEE_ZERO, [transfer(DESTINATION_ACCOUNT)]),
      [[]]
    );
    assert.deepEqual(reads, []);
  });

  it("refuses a hook program that publishes no extra account list", async () => {
    const { rpc } = stubRpc(new Map());
    await assert.rejects(
      resolveTransferHookAccounts(rpc, HOOKED, [transfer(DESTINATION_ACCOUNT)]),
      refusal(TOKEN_MOVEMENT_REFUSALS.hookUnresolved)
    );
  });

  it("resolves what the token-2022 client resolves, reading the list once for every transfer", async () => {
    const { validation, accounts } = await validationAccounts(EXTRA_METAS);
    const { rpc, reads } = stubRpc(accounts);
    const destinations = [DESTINATION_ACCOUNT, testAddress(13), testAddress(14)];

    const resolved = await resolveTransferHookAccounts(rpc, HOOKED, destinations.map(transfer));

    assert.deepEqual(reads, [validation]);
    for (const [index, destination] of destinations.entries()) {
      const expected = await resolveExtraAccountMetasForExecute({
        rpc,
        transferHookProgramAddress: HOOK_PROGRAM,
        ...transfer(destination),
        mint: MINT,
      });
      assert.deepEqual(resolved[index], expected);
    }
    assert.notDeepEqual(resolved[0], resolved[1]);
  });

  it("reads an account a seed takes data from once for all the transfers", async () => {
    const { validation, accounts } = await validationAccounts([
      {
        config: {
          __kind: "ProgramPda",
          seeds: [{ __kind: "AccountData", accountIndex: 0, dataIndex: 0, length: 32 }],
        },
        isSigner: false,
        isWritable: false,
      },
    ]);
    accounts.set(SOURCE, { owner: TOKEN_2022, data: new Uint8Array(165).fill(1) });
    const { rpc, reads } = stubRpc(accounts);
    const destinations = [DESTINATION_ACCOUNT, testAddress(13), testAddress(14)];

    await resolveTransferHookAccounts(rpc, HOOKED, destinations.map(transfer));

    // The source is the same for every transfer: one read of it, not one per transfer.
    assert.deepEqual(reads, [validation, SOURCE]);
  });

  it("refuses an extra account that must sign", async () => {
    const { accounts } = await validationAccounts([
      { config: { __kind: "Literal", address: HOOK_STATE }, isSigner: true, isWritable: false },
    ]);
    const { rpc } = stubRpc(accounts);
    await assert.rejects(
      resolveTransferHookAccounts(rpc, HOOKED, [transfer(DESTINATION_ACCOUNT)]),
      refusal(TOKEN_MOVEMENT_REFUSALS.hookUnresolved)
    );
  });
});

describe("Token ACL thaw", () => {
  const GATE = testAddress(20);
  const LIST_STATE = testAddress(21);
  const FROZEN_DEFAULT: ExtensionArgs = {
    __kind: "DefaultAccountState",
    state: AccountState.Frozen,
  };
  const NEW_DESTINATION: DestinationTokenAccount = { ...DESTINATION, exists: false };

  /** A frozen-by-default mint whose freeze authority is its Token ACL config. */
  async function aclTerms(): Promise<MintTokenTerms> {
    const [mintConfig] = await findMintConfigPda(
      { mint: MINT },
      { programAddress: TOKEN_ACL_PROGRAM_ADDRESS }
    );
    return mintTerms(TOKEN_2022, [FROZEN_DEFAULT], mintConfig);
  }

  /** One literal account, and the gate's wallet entry PDA seeded by the token account's owner. */
  const THAW_METAS: ExtraAccountMeta[] = [
    { config: { __kind: "Literal", address: LIST_STATE }, isSigner: false, isWritable: false },
    {
      config: {
        __kind: "ProgramPda",
        seeds: [
          { __kind: "Literal", bytes: new TextEncoder().encode("wallet_entry") },
          { __kind: "AccountKey", index: 3 },
        ],
      },
      isSigner: false,
      isWritable: false,
    },
  ];

  /** The chain an ACL mint publishes: its config and its gate's thaw account list. */
  async function aclChain(options: { permissionlessThaw: boolean; metas: ExtraAccountMeta[] }) {
    const [mintConfig] = await findMintConfigPda(
      { mint: MINT },
      { programAddress: TOKEN_ACL_PROGRAM_ADDRESS }
    );
    const [thawList] = await findThawExtraMetasAccountPda({ mint: MINT }, { programAddress: GATE });
    const accounts = new Map<Address, StoredAccount>([
      [
        mintConfig,
        {
          owner: TOKEN_ACL_PROGRAM_ADDRESS,
          data: getMintConfigEncoder().encode({
            bump: 255,
            enablePermissionlessThaw: options.permissionlessThaw,
            enablePermissionlessFreeze: false,
            mint: MINT,
            freezeAuthority: AUTHORITY,
            gatingProgram: GATE,
          }),
        },
      ],
      [thawList, { owner: GATE, data: getExtraAccountMetasEncoder().encode(options.metas) }],
    ]);
    return { mintConfig, thawList, accounts };
  }

  it("reads nothing when no destination opens frozen", async () => {
    const { rpc, reads } = stubRpc(new Map());
    assert.deepEqual(await resolveTokenAclThaws(rpc, await aclTerms(), [DESTINATION], SOURCE), [
      null,
    ]);
    assert.deepEqual(await resolveTokenAclThaws(rpc, FEE_ZERO, [NEW_DESTINATION], SOURCE), [null]);
    assert.deepEqual(reads, []);
  });

  it("refuses a freeze authority that is not the mint's Token ACL config, reading nothing", async () => {
    const { rpc, reads } = stubRpc(new Map());
    await assert.rejects(
      resolveTokenAclThaws(rpc, terms(TOKEN_2022, [FROZEN_DEFAULT]), [NEW_DESTINATION], SOURCE),
      refusal(TOKEN_MOVEMENT_REFUSALS.defaultFrozen)
    );
    assert.deepEqual(reads, []);
  });

  it("refuses a missing config, a config without permissionless thaw, and a gate without a list", async () => {
    const aclMint = await aclTerms();
    const missing = stubRpc(new Map());
    await assert.rejects(
      resolveTokenAclThaws(missing.rpc, aclMint, [NEW_DESTINATION], SOURCE),
      refusal(TOKEN_MOVEMENT_REFUSALS.defaultFrozen)
    );

    const disabled = await aclChain({ permissionlessThaw: false, metas: THAW_METAS });
    await assert.rejects(
      resolveTokenAclThaws(stubRpc(disabled.accounts).rpc, aclMint, [NEW_DESTINATION], SOURCE),
      refusal(TOKEN_MOVEMENT_REFUSALS.defaultFrozen)
    );

    const noList = await aclChain({ permissionlessThaw: true, metas: THAW_METAS });
    noList.accounts.delete(noList.thawList);
    await assert.rejects(
      resolveTokenAclThaws(stubRpc(noList.accounts).rpc, aclMint, [NEW_DESTINATION], SOURCE),
      refusal(TOKEN_MOVEMENT_REFUSALS.defaultFrozen)
    );
  });

  it("resolves each new destination's thaw, reading the config and list once", async () => {
    const chain = await aclChain({ permissionlessThaw: true, metas: THAW_METAS });
    const { rpc, reads } = stubRpc(chain.accounts);
    const second: DestinationTokenAccount = {
      ...NEW_DESTINATION,
      owner: testAddress(22),
      tokenAccount: testAddress(23),
    };

    const thaws = await resolveTokenAclThaws(
      rpc,
      await aclTerms(),
      [NEW_DESTINATION, DESTINATION, second],
      SOURCE
    );

    assert.deepEqual(reads, [chain.mintConfig, chain.thawList]);
    assert.equal(thaws[1], null);
    for (const [index, destination] of [NEW_DESTINATION, second].entries()) {
      const thaw = thaws[index * 2];
      assert.ok(thaw);
      const [flagAccount] = await findFlagAccountPda(
        { tokenAccount: destination.tokenAccount },
        { programAddress: TOKEN_ACL_PROGRAM_ADDRESS }
      );
      const [walletEntry] = await getProgramDerivedAddress({
        programAddress: GATE,
        seeds: [
          new TextEncoder().encode("wallet_entry"),
          getAddressEncoder().encode(destination.owner),
        ],
      });
      assert.deepEqual(thaw, {
        authority: SOURCE,
        mintConfig: chain.mintConfig,
        gatingProgram: GATE,
        flagAccount,
        extraAccounts: [
          { address: chain.thawList, role: AccountRole.READONLY },
          { address: LIST_STATE, role: AccountRole.READONLY },
          { address: walletEntry, role: AccountRole.READONLY },
        ],
      });
    }
  });

  it("refuses a gate account that must sign", async () => {
    const chain = await aclChain({
      permissionlessThaw: true,
      metas: [
        { config: { __kind: "Literal", address: LIST_STATE }, isSigner: true, isWritable: false },
      ],
    });
    await assert.rejects(
      resolveTokenAclThaws(
        stubRpc(chain.accounts).rpc,
        await aclTerms(),
        [NEW_DESTINATION],
        SOURCE
      ),
      refusal(TOKEN_MOVEMENT_REFUSALS.defaultFrozen)
    );
  });

  it("thaws a new destination right after its create, signed by the movement's authority", async () => {
    const chain = await aclChain({ permissionlessThaw: true, metas: THAW_METAS });
    const aclMint = await aclTerms();
    const [thaw] = await resolveTokenAclThaws(
      stubRpc(chain.accounts).rpc,
      aclMint,
      [NEW_DESTINATION],
      SOURCE
    );
    assert.ok(thaw);

    const [create, thawIx, transfer, ...rest] = buildTokenMovement(
      aclMint,
      debit(aclMint, "1"),
      tokenContext({ destination: NEW_DESTINATION, thaw }, {})
    );

    assert.equal(rest.length, 0);
    assert.equal(create.programAddress, ASSOCIATED_TOKEN_PROGRAM_ADDRESS);
    assert.equal(transfer.programAddress, TOKEN_2022);
    assert.equal(thawIx.programAddress, TOKEN_ACL_PROGRAM_ADDRESS);
    assert.deepEqual(
      thawIx.data,
      getThawPermissionlessIdempotentInstructionDataEncoder().encode({})
    );
    assert.deepEqual(
      thawIx.accounts?.map((meta) => [meta.address, meta.role]),
      [
        [SOURCE, AccountRole.READONLY_SIGNER],
        [MINT, AccountRole.READONLY],
        [DESTINATION_ACCOUNT, AccountRole.WRITABLE],
        [thaw.flagAccount, AccountRole.WRITABLE],
        [OWNER, AccountRole.READONLY],
        [chain.mintConfig, AccountRole.READONLY],
        [TOKEN_2022, AccountRole.READONLY],
        [SYSTEM_PROGRAM_ADDRESS, AccountRole.READONLY],
        [GATE, AccountRole.READONLY],
        ...thaw.extraAccounts.map((meta) => [meta.address, meta.role]),
      ]
    );
  });

  it("refuses a new frozen destination without its thaw, and an existing frozen one", async () => {
    const aclMint = await aclTerms();
    assert.throws(
      () =>
        assertMovementBuildable(aclMint, debit(aclMint, "1"), {
          accounts: { ...TOKEN_ACCOUNTS, destination: NEW_DESTINATION },
          memo: null,
        }),
      refusal(TOKEN_MOVEMENT_REFUSALS.defaultFrozen)
    );
    assert.throws(
      () =>
        assertMovementBuildable(CLASSIC, debit(CLASSIC, "1"), {
          accounts: { ...TOKEN_ACCOUNTS, destination: { ...DESTINATION, frozen: true } },
          memo: null,
        }),
      refusal(TOKEN_MOVEMENT_REFUSALS.destinationFrozen)
    );
  });

  it("fails loudly on a thaw for an account that does not open frozen, or for another authority", async () => {
    const chain = await aclChain({ permissionlessThaw: true, metas: THAW_METAS });
    const aclMint = await aclTerms();
    const [thaw] = await resolveTokenAclThaws(
      stubRpc(chain.accounts).rpc,
      aclMint,
      [NEW_DESTINATION],
      SOURCE
    );
    assert.ok(thaw);
    assert.throws(
      () =>
        assertMovementBuildable(aclMint, debit(aclMint, "1"), {
          accounts: { ...TOKEN_ACCOUNTS, thaw },
          memo: null,
        }),
      (cause: unknown) => cause instanceof Error && !(cause instanceof TokenMovementError)
    );
    assert.throws(
      () =>
        buildTokenMovement(aclMint, debit(aclMint, "1"), {
          ...tokenContext({ destination: NEW_DESTINATION, thaw }, {}),
          authority: createNoopSigner(testAddress(24)),
        }),
      /another authority/
    );
  });
});
