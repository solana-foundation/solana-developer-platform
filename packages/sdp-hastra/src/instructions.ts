import { randomBytes } from "node:crypto";
import type { EarnVaultInstruction } from "@sdp/earn/types";
import {
  type Address,
  address,
  createAddressWithSeed,
  createNoopSigner,
  type Instruction,
} from "@solana/kit";
import {
  getCreateAccountWithSeedInstruction,
  getTransferSolInstruction,
} from "@solana-program/system";
import type { HastraClusterConfig } from "./addresses";
import { addressBytes, associatedTokenAddress } from "./addresses";
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

export async function createAssociatedTokenInstruction(
  payer: Address,
  owner: Address,
  mint: Address
): Promise<EarnVaultInstruction> {
  return {
    programAddress: ASSOCIATED_TOKEN_PROGRAM_ID,
    accounts: [
      { address: payer, role: 3 },
      { address: await associatedTokenAddress(owner, mint), role: 1 },
      { address: owner, role: 0 },
      { address: mint, role: 0 },
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
  rentPayer: Address,
  owner: Address,
  lamports: bigint
): EarnVaultInstruction {
  return planInstruction(
    getTransferSolInstruction({
      source: createNoopSigner(rentPayer),
      destination: owner,
      amount: lamports,
    })
  );
}

/** A kit instruction in the plan's own vocabulary; kit's `AccountRole` numbers are the wire roles. */
function planInstruction(instruction: Instruction): EarnVaultInstruction {
  return {
    programAddress: instruction.programAddress,
    accounts: (instruction.accounts ?? []).map((account) => ({
      address: account.address,
      role: account.role,
    })),
    data: Buffer.from(instruction.data ?? new Uint8Array()).toString("base64"),
  };
}

function initializeClassicTokenAccountInstruction(
  account: Address,
  mint: Address,
  owner: Address
): EarnVaultInstruction {
  return {
    programAddress: TOKEN_PROGRAM_ID,
    accounts: [
      { address: account, role: 1 },
      { address: mint, role: 0 },
    ],
    // SPL Token: InitializeAccount3 { owner }.
    data: Buffer.concat([Buffer.from([18]), addressBytes(owner)]).toString("base64"),
  };
}

function transferClassicTokensInstruction(
  source: Address,
  destination: Address,
  owner: Address,
  amount: bigint
): EarnVaultInstruction {
  const data = Buffer.alloc(9);
  data[0] = 3; // SPL Token: Transfer
  data.writeBigUInt64LE(amount, 1);
  return {
    programAddress: TOKEN_PROGRAM_ID,
    accounts: [
      { address: source, role: 1 },
      { address: destination, role: 1 },
      { address: owner, role: 2 },
    ],
    data: data.toString("base64"),
  };
}

function closeClassicTokenAccountInstruction(
  account: Address,
  refundTo: Address,
  owner: Address
): EarnVaultInstruction {
  return {
    programAddress: TOKEN_PROGRAM_ID,
    accounts: [
      { address: account, role: 1 },
      { address: refundTo, role: 1 },
      { address: owner, role: 2 },
    ],
    data: Buffer.from([9]).toString("base64"), // SPL Token: CloseAccount
  };
}

interface TransientTokenAccountPlan {
  address: Address;
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
  payer: Address;
  owner: Address;
  mint: Address;
  destination: Address;
  refundTo: Address;
  amount: bigint;
}): Promise<TransientTokenAccountPlan> {
  const rentLamports = await rentExemptMinimum(
    args.runtime,
    CLASSIC_TOKEN_ACCOUNT_BYTES,
    "classic token-account"
  );
  const seed = `sdp-hastra-${randomBytes(10).toString("hex")}`;
  const tokenProgram = address(TOKEN_PROGRAM_ID);
  const transient = await createAddressWithSeed({
    baseAddress: args.owner,
    programAddress: tokenProgram,
    seed,
  });
  const create = getCreateAccountWithSeedInstruction({
    payer: createNoopSigner(args.payer),
    newAccount: transient,
    // The base signs separately only when it is not already the paying signer.
    baseAccount: args.owner === args.payer ? undefined : createNoopSigner(args.owner),
    base: args.owner,
    seed,
    amount: rentLamports,
    space: CLASSIC_TOKEN_ACCOUNT_BYTES,
    programAddress: tokenProgram,
  });
  return {
    address: transient,
    setupInstructions: [
      planInstruction(create),
      initializeClassicTokenAccountInstruction(transient, args.mint, args.owner),
    ],
    settleInstructions: [
      transferClassicTokensInstruction(transient, args.destination, args.owner, args.amount),
      closeClassicTokenAccountInstruction(transient, args.refundTo, args.owner),
    ],
  };
}

export function mintDepositInstruction(args: {
  config: HastraClusterConfig;
  state: HastraState;
  owner: Address;
  userUsdc: Address;
  userWylds: Address;
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
      { address: args.owner, role: 2 },
      { address: args.userUsdc, role: 1 },
      { address: args.userWylds, role: 1 },
      { address: TOKEN_PROGRAM_ID, role: 0 },
    ],
    data: anchorAmountData("deposit", args.amount),
  };
}

export function stakeDepositInstruction(args: {
  config: HastraClusterConfig;
  state: HastraState;
  owner: Address;
  userWylds: Address;
  userPrime: Address;
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
      { address: args.owner, role: 2 },
      { address: args.userWylds, role: 1 },
      { address: args.userPrime, role: 1 },
      { address: args.state.addresses.stakePriceConfig, role: 0 },
      { address: TOKEN_PROGRAM_ID, role: 0 },
    ],
    data: anchorAmountData("deposit", args.amount),
  };
}

export function stakeRedeemInstruction(args: {
  config: HastraClusterConfig;
  state: HastraState;
  owner: Address;
  userWylds: Address;
  userPrime: Address;
  legacyTicket: Address | null;
  amount: bigint;
}): EarnVaultInstruction {
  return {
    programAddress: args.config.deployment.vaultStakeProgramAddress,
    accounts: [
      { address: args.state.addresses.stakeConfig, role: 0 },
      { address: args.state.addresses.stakeVaultTokenAccountConfig, role: 0 },
      { address: args.state.stakeVaultTokenAccount, role: 1 },
      { address: args.state.addresses.stakeVaultAuthority, role: 0 },
      { address: args.owner, role: 3 },
      {
        // Anchor 0.31's Option<Account> sentinel is the executing program id.
        address: args.legacyTicket ?? args.config.deployment.vaultStakeProgramAddress,
        role: args.legacyTicket === null ? 0 : 1,
      },
      { address: args.userWylds, role: 1 },
      { address: args.userPrime, role: 1 },
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
  owner: Address;
  userWylds: Address;
  request: Address;
  amount: bigint;
}): EarnVaultInstruction {
  return {
    programAddress: args.config.deployment.vaultMintProgramAddress,
    accounts: [
      { address: args.owner, role: 3 },
      { address: args.userWylds, role: 1 },
      { address: args.request, role: 1 },
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
  owner: Address;
  userWylds: Address;
  request: Address;
}): EarnVaultInstruction {
  return {
    programAddress: args.config.deployment.vaultMintProgramAddress,
    accounts: [
      { address: args.owner, role: 3 },
      { address: args.userWylds, role: 1 },
      { address: args.request, role: 1 },
      { address: args.state.addresses.redeemVaultAuthority, role: 0 },
      { address: args.state.addresses.mintConfig, role: 0 },
      { address: TOKEN_PROGRAM_ID, role: 0 },
    ],
    data: anchorNoArgsData("cancel_redeem"),
  };
}
