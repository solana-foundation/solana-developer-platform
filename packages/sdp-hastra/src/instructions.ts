import { randomBytes } from "node:crypto";
import type { EarnVaultInstruction } from "@sdp/earn/types";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import type { HastraClusterConfig } from "./addresses";
import { associatedTokenAddress } from "./addresses";
import { anchorAmountData, anchorNoArgsData } from "./codec";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  CLASSIC_TOKEN_ACCOUNT_BYTES,
  COMPUTE_BUDGET_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "./constants";
import { rentExemptMinimum } from "./rpc";
import type { HastraState } from "./state";
import type { HastraRuntime } from "./types";

export function computeUnitLimitInstruction(units: number): EarnVaultInstruction {
  const data = Buffer.alloc(5);
  data[0] = 2; // ComputeBudgetInstruction::SetComputeUnitLimit
  data.writeUInt32LE(units, 1);
  return { programAddress: COMPUTE_BUDGET_PROGRAM_ID, accounts: [], data: data.toString("base64") };
}

export function createAssociatedTokenInstruction(
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey
): EarnVaultInstruction {
  return {
    programAddress: ASSOCIATED_TOKEN_PROGRAM_ID,
    accounts: [
      { address: payer.toBase58(), role: 3 },
      { address: associatedTokenAddress(owner, mint).toBase58(), role: 1 },
      { address: owner.toBase58(), role: 0 },
      { address: mint.toBase58(), role: 0 },
      { address: SYSTEM_PROGRAM_ID, role: 0 },
      { address: TOKEN_PROGRAM_ID, role: 0 },
    ],
    // Associated Token Program: CreateIdempotent
    data: Buffer.from([1]).toString("base64"),
  };
}

/**
 * One System transfer of `lamports` from a sponsored rent payer to the owner:
 * the prefund a sponsored par request prepends for `request_redeem`, whose
 * account table hardcodes the owner as the request account's rent payer (see
 * `buildParRedemptionRequest`). The sponsor signs nothing new — it is already
 * the transaction fee payer, so compilation covers the transfer's source with
 * the same fee-payer signature. Same mechanism as Veda's allowed-user prefund.
 */
export function prefundOwnerRentInstruction(
  rentPayer: PublicKey,
  owner: PublicKey,
  lamports: bigint
): EarnVaultInstruction {
  return web3Instruction(
    SystemProgram.transfer({ fromPubkey: rentPayer, toPubkey: owner, lamports })
  );
}

function web3Instruction(instruction: {
  programId: PublicKey;
  keys: readonly { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[];
  data: Buffer;
}): EarnVaultInstruction {
  return {
    programAddress: instruction.programId.toBase58(),
    accounts: instruction.keys.map((account) => ({
      address: account.pubkey.toBase58(),
      role: (account.isSigner ? 2 : 0) + (account.isWritable ? 1 : 0),
    })),
    data: instruction.data.toString("base64"),
  };
}

function initializeClassicTokenAccountInstruction(
  account: PublicKey,
  mint: PublicKey,
  owner: PublicKey
): EarnVaultInstruction {
  return {
    programAddress: TOKEN_PROGRAM_ID,
    accounts: [
      { address: account.toBase58(), role: 1 },
      { address: mint.toBase58(), role: 0 },
    ],
    // SPL Token: InitializeAccount3 { owner }.
    data: Buffer.concat([Buffer.from([18]), owner.toBuffer()]).toString("base64"),
  };
}

function transferClassicTokensInstruction(
  source: PublicKey,
  destination: PublicKey,
  owner: PublicKey,
  amount: bigint
): EarnVaultInstruction {
  const data = Buffer.alloc(9);
  data[0] = 3; // SPL Token: Transfer
  data.writeBigUInt64LE(amount, 1);
  return {
    programAddress: TOKEN_PROGRAM_ID,
    accounts: [
      { address: source.toBase58(), role: 1 },
      { address: destination.toBase58(), role: 1 },
      { address: owner.toBase58(), role: 2 },
    ],
    data: data.toString("base64"),
  };
}

function closeClassicTokenAccountInstruction(
  account: PublicKey,
  refundTo: PublicKey,
  owner: PublicKey
): EarnVaultInstruction {
  return {
    programAddress: TOKEN_PROGRAM_ID,
    accounts: [
      { address: account.toBase58(), role: 1 },
      { address: refundTo.toBase58(), role: 1 },
      { address: owner.toBase58(), role: 2 },
    ],
    data: Buffer.from([9]).toString("base64"), // SPL Token: CloseAccount
  };
}

interface TransientTokenAccountPlan {
  address: PublicKey;
  setupInstructions: EarnVaultInstruction[];
  settleInstructions: EarnVaultInstruction[];
}

/**
 * Isolate a price-sensitive redeem in an account that cannot be dusted before
 * execution. Moving exactly `amount` out and then closing it is an on-chain
 * equality assertion: a lower live output makes the transfer fail, while a
 * higher output leaves a balance and makes the close fail. The whole composed
 * transaction rolls back in either case and callers rebuild at the new rate.
 */
export async function transientTokenAccountPlan(args: {
  runtime: HastraRuntime;
  payer: PublicKey;
  owner: PublicKey;
  mint: PublicKey;
  destination: PublicKey;
  refundTo: PublicKey;
  amount: bigint;
}): Promise<TransientTokenAccountPlan> {
  const rentLamports = await rentExemptMinimum(
    args.runtime,
    CLASSIC_TOKEN_ACCOUNT_BYTES,
    "classic token-account"
  );
  const seed = `sdp-hastra-${randomBytes(10).toString("hex")}`;
  const tokenProgram = new PublicKey(TOKEN_PROGRAM_ID);
  const address = await PublicKey.createWithSeed(args.owner, seed, tokenProgram);
  const create = SystemProgram.createAccountWithSeed({
    fromPubkey: args.payer,
    newAccountPubkey: address,
    basePubkey: args.owner,
    seed,
    lamports: rentLamports,
    space: CLASSIC_TOKEN_ACCOUNT_BYTES,
    programId: tokenProgram,
  });
  return {
    address,
    setupInstructions: [
      web3Instruction(create),
      initializeClassicTokenAccountInstruction(address, args.mint, args.owner),
    ],
    settleInstructions: [
      transferClassicTokensInstruction(address, args.destination, args.owner, args.amount),
      closeClassicTokenAccountInstruction(address, args.refundTo, args.owner),
    ],
  };
}

export function mintDepositInstruction(args: {
  config: HastraClusterConfig;
  state: HastraState;
  owner: PublicKey;
  userUsdc: PublicKey;
  userWylds: PublicKey;
  amount: bigint;
}): EarnVaultInstruction {
  return {
    programAddress: args.config.deployment.vaultMintProgramAddress,
    accounts: [
      { address: args.state.addresses.mintConfig, role: 0 },
      { address: args.state.addresses.mintVaultTokenAccountConfig, role: 0 },
      { address: args.state.mintVaultTokenAccount, role: 1 },
      { address: args.config.deployment.wYldsMint, role: 1 },
      { address: args.state.addresses.mintAuthority, role: 0 },
      { address: args.owner.toBase58(), role: 2 },
      { address: args.userUsdc.toBase58(), role: 1 },
      { address: args.userWylds.toBase58(), role: 1 },
      { address: TOKEN_PROGRAM_ID, role: 0 },
    ],
    data: anchorAmountData("deposit", args.amount),
  };
}

export function stakeDepositInstruction(args: {
  config: HastraClusterConfig;
  state: HastraState;
  owner: PublicKey;
  userWylds: PublicKey;
  userPrime: PublicKey;
  amount: bigint;
}): EarnVaultInstruction {
  return {
    programAddress: args.config.deployment.vaultStakeProgramAddress,
    accounts: [
      { address: args.state.addresses.stakeConfig, role: 0 },
      { address: args.state.addresses.stakeVaultTokenAccountConfig, role: 0 },
      { address: args.state.stakeVaultTokenAccount, role: 1 },
      { address: args.state.addresses.stakeVaultAuthority, role: 0 },
      { address: args.config.deployment.primeMint, role: 1 },
      { address: args.config.deployment.wYldsMint, role: 1 },
      { address: args.state.addresses.stakeMintAuthority, role: 0 },
      { address: args.owner.toBase58(), role: 2 },
      { address: args.userWylds.toBase58(), role: 1 },
      { address: args.userPrime.toBase58(), role: 1 },
      { address: args.state.addresses.stakePriceConfig, role: 0 },
      { address: TOKEN_PROGRAM_ID, role: 0 },
    ],
    data: anchorAmountData("deposit", args.amount),
  };
}

export function stakeRedeemInstruction(args: {
  config: HastraClusterConfig;
  state: HastraState;
  owner: PublicKey;
  userWylds: PublicKey;
  userPrime: PublicKey;
  legacyTicket: PublicKey | null;
  amount: bigint;
}): EarnVaultInstruction {
  return {
    programAddress: args.config.deployment.vaultStakeProgramAddress,
    accounts: [
      { address: args.state.addresses.stakeConfig, role: 0 },
      { address: args.state.addresses.stakeVaultTokenAccountConfig, role: 0 },
      { address: args.state.stakeVaultTokenAccount, role: 1 },
      { address: args.state.addresses.stakeVaultAuthority, role: 0 },
      { address: args.owner.toBase58(), role: 3 },
      {
        // Anchor 0.31's Option<Account> sentinel is the executing program id.
        address: args.legacyTicket?.toBase58() ?? args.config.deployment.vaultStakeProgramAddress,
        role: args.legacyTicket === null ? 0 : 1,
      },
      { address: args.userWylds.toBase58(), role: 1 },
      { address: args.userPrime.toBase58(), role: 1 },
      { address: args.config.deployment.primeMint, role: 1 },
      { address: args.config.deployment.wYldsMint, role: 1 },
      { address: args.state.addresses.stakePriceConfig, role: 0 },
      { address: TOKEN_PROGRAM_ID, role: 0 },
    ],
    data: anchorAmountData("redeem", args.amount),
  };
}

export function parRequestInstruction(args: {
  config: HastraClusterConfig;
  state: HastraState;
  owner: PublicKey;
  userWylds: PublicKey;
  request: PublicKey;
  amount: bigint;
}): EarnVaultInstruction {
  return {
    programAddress: args.config.deployment.vaultMintProgramAddress,
    accounts: [
      { address: args.owner.toBase58(), role: 3 },
      { address: args.userWylds.toBase58(), role: 1 },
      { address: args.request.toBase58(), role: 1 },
      { address: args.state.addresses.redeemVaultAuthority, role: 0 },
      { address: args.config.deployment.wYldsMint, role: 0 },
      { address: args.state.addresses.mintConfig, role: 0 },
      { address: SYSTEM_PROGRAM_ID, role: 0 },
      { address: TOKEN_PROGRAM_ID, role: 0 },
    ],
    data: anchorAmountData("request_redeem", args.amount),
  };
}

export function parCancelInstruction(args: {
  config: HastraClusterConfig;
  state: HastraState;
  owner: PublicKey;
  userWylds: PublicKey;
  request: PublicKey;
}): EarnVaultInstruction {
  return {
    programAddress: args.config.deployment.vaultMintProgramAddress,
    accounts: [
      { address: args.owner.toBase58(), role: 3 },
      { address: args.userWylds.toBase58(), role: 1 },
      { address: args.request.toBase58(), role: 1 },
      { address: args.state.addresses.redeemVaultAuthority, role: 0 },
      { address: args.state.addresses.mintConfig, role: 0 },
      { address: TOKEN_PROGRAM_ID, role: 0 },
    ],
    data: anchorNoArgsData("cancel_redeem"),
  };
}
