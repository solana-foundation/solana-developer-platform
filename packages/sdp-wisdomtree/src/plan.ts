import { SPL_TOKEN_PROGRAMS } from "@sdp/types";
import type { WisdomTreeFund } from "@sdp/types/wisdomtree-programs";
import { WISDOMTREE_TRANSFER_HOOK_PROGRAM_IDS } from "@sdp/types/wisdomtree-programs";
import type { Address, Instruction, TransactionSigner } from "@solana/kit";
import { address } from "@solana/kit";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
} from "@solana-program/token-2022";
import { acceptAtMintScale } from "./amounts";
import type { WisdomTreeChainReader } from "./chain";
import { SdpWisdomTreeError } from "./errors";
import { assertPlanTargetsCluster } from "./guards";
import { parseFundMint } from "./mint";
import type { WisdomTreeInstructionPlan, WisdomTreeRuntime } from "./types";

const SPL_TOKEN_PROGRAM = address(SPL_TOKEN_PROGRAMS["spl-token"]);
const TOKEN_2022_PROGRAM = address(SPL_TOKEN_PROGRAMS["token-2022"]);

export interface WisdomTreeDepositPlanInput {
  fund: WisdomTreeFund;
  /** Wallet whose USDC leaves and whose fund tokens later settle. A signer-shaped address (noop signer). */
  owner: TransactionSigner;
  /** WisdomTree's on-receipt Purchase wallet, resolved from the Connect API at build time. */
  onReceiptWallet: Address;
  /** The deposit stablecoin's mint and scale on this cluster. */
  depositMint: Address;
  depositDecimals: number;
  /** Deposit amount in the stablecoin's own units, as a decimal string. */
  amount: string;
  /** Rent funder for any ATA this plan must create. NOT the fee payer. Defaults to the owner. */
  rentPayer?: TransactionSigner;
}

/**
 * Verify the live fund mint against the measured registry before any plan is
 * built against it: owner program, decimals, and transfer-hook program must
 * all match, or the instrument has drifted from what SDP audited and the build
 * refuses. This is the builder-truth half of `assetIdentity` — for a vaultless
 * provider the mint account IS the live state a vault read would be.
 */
export async function verifyFundMint(
  reader: WisdomTreeChainReader,
  runtime: WisdomTreeRuntime,
  fund: WisdomTreeFund
): Promise<void> {
  const account = await reader.getAccount(address(fund.mint));
  if (account === null) {
    throw new SdpWisdomTreeError(
      "MINT_MISMATCH",
      `Fund mint ${fund.mint} does not exist on ${runtime.cluster}.`
    );
  }
  if (account.owner !== String(TOKEN_2022_PROGRAM)) {
    throw new SdpWisdomTreeError(
      "MINT_MISMATCH",
      `Fund mint ${fund.mint} is owned by ${account.owner}, not the Token-2022 program.`
    );
  }
  const parsed = parseFundMint(account.data);
  if (parsed.decimals !== fund.decimals) {
    throw new SdpWisdomTreeError(
      "MINT_MISMATCH",
      `Fund mint ${fund.mint} carries ${parsed.decimals} decimals; the registry states ${fund.decimals}.`
    );
  }
  const expectedHook = WISDOMTREE_TRANSFER_HOOK_PROGRAM_IDS[runtime.cluster];
  if (parsed.transferHookProgram !== expectedHook) {
    throw new SdpWisdomTreeError(
      "MINT_MISMATCH",
      `Fund mint ${fund.mint} names transfer hook ${parsed.transferHookProgram ?? "none"}; ` +
        `the registry states ${expectedHook ?? "none"} for ${runtime.cluster}.`
    );
  }
}

/**
 * Build the on-chain leg of a WisdomTree primary-market SUBSCRIPTION: a
 * TransferChecked of USDC from the owner to WisdomTree's on-receipt Purchase
 * wallet. There is no vault instruction — receiving the USDC from a
 * KYC-registered wallet is what opens the order on WisdomTree's side, and the
 * fund tokens settle back to the owner after NAV strike, OUTSIDE this
 * transaction.
 *
 * The plan also creates (idempotently, and only when measured absent):
 * - the on-receipt wallet's USDC ATA — so a first-ever transfer to a fresh
 *   settlement wallet cannot fail on a missing account;
 * - the owner's fund-token ATA — so WisdomTree's settlement leg has an account
 *   to land in. This is the `createsShareAccount` the caller records for rent
 *   attribution, same contract (and same read-then-broadcast residual) as the
 *   Kamino share ATA.
 */
export async function buildWisdomTreeDepositPlan(
  reader: WisdomTreeChainReader,
  runtime: WisdomTreeRuntime,
  input: WisdomTreeDepositPlanInput
): Promise<WisdomTreeInstructionPlan> {
  await verifyFundMint(reader, runtime, input.fund);

  const accepted = acceptAtMintScale(input.amount, input.depositDecimals, "Deposit amount");
  const rentPayer = input.rentPayer ?? input.owner;
  const fundMint = address(input.fund.mint);

  const [ownerUsdcAta] = await findAssociatedTokenPda({
    owner: input.owner.address,
    tokenProgram: SPL_TOKEN_PROGRAM,
    mint: input.depositMint,
  });
  const [onReceiptUsdcAta] = await findAssociatedTokenPda({
    owner: input.onReceiptWallet,
    tokenProgram: SPL_TOKEN_PROGRAM,
    mint: input.depositMint,
  });
  const [ownerFundAta] = await findAssociatedTokenPda({
    owner: input.owner.address,
    tokenProgram: TOKEN_2022_PROGRAM,
    mint: fundMint,
  });

  // Measured, not assumed — the contract's `createsShareAccount` is a claim
  // about who paid rent, and only a chain read can make it.
  const [ownerFundAccount, onReceiptUsdcAccount] = await Promise.all([
    reader.getAccount(ownerFundAta),
    reader.getAccount(onReceiptUsdcAta),
  ]);
  const createsShareAccount = ownerFundAccount === null;

  const instructions: Instruction[] = [];
  if (createsShareAccount) {
    instructions.push(
      getCreateAssociatedTokenIdempotentInstruction({
        payer: rentPayer,
        ata: ownerFundAta,
        owner: input.owner.address,
        mint: fundMint,
        tokenProgram: TOKEN_2022_PROGRAM,
      })
    );
  }
  if (onReceiptUsdcAccount === null) {
    instructions.push(
      getCreateAssociatedTokenIdempotentInstruction({
        payer: rentPayer,
        ata: onReceiptUsdcAta,
        owner: input.onReceiptWallet,
        mint: input.depositMint,
        tokenProgram: SPL_TOKEN_PROGRAM,
      })
    );
  }
  instructions.push(
    getTransferCheckedInstruction(
      {
        source: ownerUsdcAta,
        mint: input.depositMint,
        destination: onReceiptUsdcAta,
        authority: input.owner,
        amount: accepted.baseUnits,
        decimals: input.depositDecimals,
      },
      { programAddress: SPL_TOKEN_PROGRAM }
    )
  );

  return assertPlanTargetsCluster({
    cluster: runtime.cluster,
    instructions,
    lookupTables: [],
    assetIdentity: { depositTokenMint: input.depositMint, shareMint: fundMint },
    accepted: { amount: accepted.canonical },
    createsShareAccount,
  });
}
