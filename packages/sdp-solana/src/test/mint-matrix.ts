/**
 * The mint matrix: one mint per Token Terms profile on a local surfnet
 * (ADR 0012). Each later token-movement path runs against every profile.
 *
 * The fixture builds real mints with the program's own instructions, so a
 * test reads back what the program wrote. The payer signs as every authority.
 *
 * The `hook` profile names a hook program that is not deployed. Its terms
 * decode like any hook mint, and every transfer of it fails, because the
 * program cannot run the hook and no extra account metas exist.
 */

import type { TokenProgramKind } from "@sdp/types/well-known-tokens";
import { SPL_TOKEN_PROGRAMS } from "@sdp/types/well-known-tokens";
import {
  type Address,
  address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  type Instruction,
  pipe,
  type Rpc,
  type Signature,
  type SolanaRpcApi,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type TransactionSigner,
  type UnixTimestamp,
} from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  AccountState,
  type ExtensionArgs,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getInitializeMintInstruction,
  getMintSize,
  getMintToInstruction,
  getPauseInstruction,
  getPreInitializeInstructionsForMintExtensions,
  getUpdateMultiplierScaledUiMintInstruction,
} from "@solana-program/token-2022";

/** A local surfnet and the funded key that pays and signs as every authority. */
export interface MatrixChain {
  rpc: Rpc<SolanaRpcApi>;
  payer: TransactionSigner;
}

export const MINT_PROFILES = [
  "classic",
  "token2022Plain",
  "feeZero",
  "feeCapped",
  "scaled",
  "scaledSwitch",
  "interestPositive",
  "interestNegative",
  "hook",
  "paused",
  "defaultFrozen",
] as const;

export type MintProfile = (typeof MINT_PROFILES)[number];

/** Every profile mint has this many decimals. */
export const MATRIX_DECIMALS = 6;

/** `feeCapped`: 50 bps, at most 5 000 base units a transfer. */
export const CAPPED_FEE = { basisPoints: 50, maximumFee: 5_000n } as const;

export const SCALED_MULTIPLIER = 1.5;

/** `scaledSwitch` moves from `SCALED_MULTIPLIER` to this at the time the test picks. */
export const SWITCHED_MULTIPLIER = 3;

/** `interestPositive` and `interestNegative`, in basis points a year. */
export const INTEREST_RATE_BPS = 500;

export interface MatrixMint {
  profile: MintProfile;
  mint: Address;
  program: TokenProgramKind;
}

export type MintMatrix = Readonly<Record<MintProfile, MatrixMint>>;

const CONFIRMATION_POLLS = 100;
const CONFIRMATION_POLL_MS = 100;

/**
 * Signs `instructions` with the payer and every signer they name, sends them
 * in one transaction and waits until it is confirmed.
 *
 * @throws The RPC's preflight error when the program refuses the transaction.
 */
export async function sendInstructions(
  chain: MatrixChain,
  instructions: readonly Instruction[]
): Promise<Signature> {
  const { value: blockhash } = await chain.rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (draft) => setTransactionMessageFeePayerSigner(chain.payer, draft),
    (draft) => setTransactionMessageLifetimeUsingBlockhash(blockhash, draft),
    (draft) => appendTransactionMessageInstructions(instructions, draft)
  );
  const transaction = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(transaction);
  await chain.rpc
    .sendTransaction(getBase64EncodedWireTransaction(transaction), { encoding: "base64" })
    .send();
  for (let poll = 0; poll < CONFIRMATION_POLLS; poll += 1) {
    const {
      value: [status],
    } = await chain.rpc.getSignatureStatuses([signature]).send();
    if (status?.err) {
      throw new Error(`Transaction ${signature} failed: ${JSON.stringify(status.err)}`);
    }
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
      return signature;
    }
    await new Promise((resolve) => setTimeout(resolve, CONFIRMATION_POLL_MS));
  }
  throw new Error(`Transaction ${signature} was not confirmed`);
}

/** The mint extensions each profile is created with. */
function profileExtensions(
  profile: MintProfile,
  authority: Address,
  hookProgram: Address
): ExtensionArgs[] | null {
  const fee = (basisPoints: number, maximumFee: bigint): ExtensionArgs => {
    const transferFee = { epoch: 0n, maximumFee, transferFeeBasisPoints: basisPoints };
    return {
      __kind: "TransferFeeConfig",
      transferFeeConfigAuthority: authority,
      withdrawWithheldAuthority: authority,
      withheldAmount: 0n,
      olderTransferFee: transferFee,
      newerTransferFee: transferFee,
    };
  };
  const interest = (rate: number): ExtensionArgs => ({
    __kind: "InterestBearingConfig",
    rateAuthority: authority,
    initializationTimestamp: 0n,
    preUpdateAverageRate: rate,
    lastUpdateTimestamp: 0n,
    currentRate: rate,
  });
  const scaled: ExtensionArgs = {
    __kind: "ScaledUiAmountConfig",
    authority,
    multiplier: SCALED_MULTIPLIER,
    newMultiplierEffectiveTimestamp: 0n,
    newMultiplier: SCALED_MULTIPLIER,
  };
  switch (profile) {
    case "classic":
    case "token2022Plain":
      return null;
    case "feeZero":
      return [fee(0, 0n)];
    case "feeCapped":
      return [fee(CAPPED_FEE.basisPoints, CAPPED_FEE.maximumFee)];
    case "scaled":
    case "scaledSwitch":
      return [scaled];
    case "interestPositive":
      return [interest(INTEREST_RATE_BPS)];
    case "interestNegative":
      return [interest(-INTEREST_RATE_BPS)];
    case "hook":
      return [{ __kind: "TransferHook", authority, programId: hookProgram }];
    case "paused":
      return [{ __kind: "PausableConfig", authority, paused: false }];
    case "defaultFrozen":
      return [{ __kind: "DefaultAccountState", state: AccountState.Frozen }];
    default: {
      const exhaustive: never = profile;
      throw new Error(`Unknown mint profile: ${String(exhaustive)}`);
    }
  }
}

async function createProfileMint(
  chain: MatrixChain,
  profile: MintProfile,
  options: { newMultiplierAt: UnixTimestamp; hookProgram: Address }
): Promise<MatrixMint> {
  const mint = await generateKeyPairSigner();
  const program: TokenProgramKind = profile === "classic" ? "spl-token" : "token-2022";
  const programAddress = address(SPL_TOKEN_PROGRAMS[program]);
  const authority = chain.payer.address;
  const extensions = profileExtensions(profile, authority, options.hookProgram);
  const space = extensions === null ? getMintSize() : getMintSize(extensions);
  const lamports = await chain.rpc.getMinimumBalanceForRentExemption(BigInt(space)).send();

  const beforeInitialize =
    extensions === null
      ? []
      : getPreInitializeInstructionsForMintExtensions(mint.address, extensions);
  const afterInitialize: Instruction[] =
    profile === "scaledSwitch"
      ? [
          getUpdateMultiplierScaledUiMintInstruction({
            mint: mint.address,
            authority: chain.payer,
            multiplier: SWITCHED_MULTIPLIER,
            effectiveTimestamp: options.newMultiplierAt,
          }),
        ]
      : [];
  await sendInstructions(chain, [
    getCreateAccountInstruction({
      payer: chain.payer,
      newAccount: mint,
      lamports,
      space,
      programAddress,
    }),
    ...beforeInitialize,
    getInitializeMintInstruction(
      {
        mint: mint.address,
        decimals: MATRIX_DECIMALS,
        mintAuthority: authority,
        freezeAuthority: authority,
      },
      { programAddress }
    ),
    ...afterInitialize,
  ]);
  return { profile, mint: mint.address, program };
}

/**
 * Creates one mint per profile, every authority the payer.
 *
 * @param options.newMultiplierAt - When `scaledSwitch` moves to `SWITCHED_MULTIPLIER`.
 * @param options.hookProgram - The hook program `hook` names; it need not exist.
 */
export async function createMintMatrix(
  chain: MatrixChain,
  options: { newMultiplierAt: UnixTimestamp; hookProgram: Address }
): Promise<MintMatrix> {
  const entries: [MintProfile, MatrixMint][] = [];
  for (const profile of MINT_PROFILES) {
    entries.push([profile, await createProfileMint(chain, profile, options)]);
  }
  // SAFETY: the loop adds exactly one entry for every profile.
  return Object.fromEntries(entries) as Record<MintProfile, MatrixMint>;
}

/** Opens the owner's associated token account for a profile mint. */
export async function openTokenAccount(
  chain: MatrixChain,
  mint: MatrixMint,
  owner: Address
): Promise<Address> {
  const tokenProgram = address(SPL_TOKEN_PROGRAMS[mint.program]);
  const [tokenAccount] = await findAssociatedTokenPda({ owner, mint: mint.mint, tokenProgram });
  await sendInstructions(chain, [
    getCreateAssociatedTokenIdempotentInstruction({
      payer: chain.payer,
      ata: tokenAccount,
      owner,
      mint: mint.mint,
      tokenProgram,
    }),
  ]);
  return tokenAccount;
}

/** Mints `amount` base units of a profile mint into `tokenAccount`. */
export async function mintTokens(
  chain: MatrixChain,
  mint: MatrixMint,
  tokenAccount: Address,
  amount: bigint
): Promise<void> {
  await sendInstructions(chain, [
    getMintToInstruction(
      { mint: mint.mint, token: tokenAccount, mintAuthority: chain.payer, amount },
      { programAddress: address(SPL_TOKEN_PROGRAMS[mint.program]) }
    ),
  ]);
}

/** Pauses a `paused`-profile mint: transfers, mints and burns of it then fail. */
export async function pauseMint(chain: MatrixChain, mint: MatrixMint): Promise<void> {
  await sendInstructions(chain, [getPauseInstruction({ mint: mint.mint, authority: chain.payer })]);
}
