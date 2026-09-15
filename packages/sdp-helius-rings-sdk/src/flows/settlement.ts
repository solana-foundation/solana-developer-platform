import { getAssociatedTokenAddress, getSplAssetVaultAddress } from "@heliuslabs/zolana/addresses";
import {
  SHIELDED_POOL_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  type TransactWithdrawal,
} from "@heliuslabs/zolana/interface";
import { WithdrawalTarget } from "@heliuslabs/zolana/transaction";
import { HeliusRingsError } from "@sdp/helius-rings";
import {
  type Address,
  createNoopSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Instruction,
} from "@solana/kit";
import { getCreateAssociatedTokenIdempotentInstruction } from "@solana-program/token";
import { isProtocolNativeMint } from "./mint.js";

/**
 * Where a public withdrawal's value lands, and what the outer transaction has
 * to carry for it to land there.
 *
 * Zolana splits the same facts across two shapes: `WithdrawalTarget` is the
 * proof-side commitment the confidential transfer is armed with, and
 * `TransactWithdrawal` is the account list the pool instruction appends. They
 * coincide for SOL and diverge for SPL, so both come out of one derivation
 * rather than being rebuilt separately and left free to disagree.
 *
 * Zolana ships this as `resolveWithdrawalSettlement`, but only behind
 * `flows/settlement.js`, which its exports map does not expose. This is the
 * same derivation over the helpers that are exported.
 */
export interface WithdrawalSettlement {
  readonly target: WithdrawalTarget;
  readonly accounts: TransactWithdrawal;
  /**
   * Instructions that must precede the pool transact. Empty for SOL; one
   * idempotent create for the recipient's associated token account otherwise.
   */
  readonly setup: readonly Instruction[];
}

const addressEncoder = getAddressEncoder();
const textEncoder = new TextEncoder();

export async function resolveWithdrawalSettlement(
  input: Readonly<{ payer: Address; recipient: Address; asset: Address }>
): Promise<WithdrawalSettlement> {
  const { payer, recipient, asset } = input;

  if (isProtocolNativeMint(asset)) {
    // `WithdrawalTarget.sol` and `TransactWithdrawal.sol` are the same shape,
    // so one value serves as both the proof target and the account list.
    const target = WithdrawalTarget.sol({ recipient });
    return { target, accounts: target, setup: [] };
  }

  const [recipientTokenAccount, splTokenInterface, splInterfaceBump] = await Promise.all([
    getAssociatedTokenAddress(recipient, asset, SPL_TOKEN_PROGRAM_ID),
    getSplAssetVaultAddress(asset),
    splAssetVaultBump(asset),
  ]);

  return {
    target: WithdrawalTarget.spl({ recipientTokenAccount, splTokenInterface, splInterfaceBump }),
    accounts: {
      kind: "spl",
      mint: asset,
      splTokenInterface,
      recipientTokenAccount,
      tokenProgram: SPL_TOKEN_PROGRAM_ID,
    },
    // Idempotent and unconditional: whether the recipient already holds the
    // account is a chain read this builder does not make, and creating it
    // every time keeps the wire one fixed shape for the policy to verify.
    setup: [
      getCreateAssociatedTokenIdempotentInstruction({
        payer: createNoopSigner(payer),
        ata: recipientTokenAccount,
        owner: recipient,
        mint: asset,
        tokenProgram: SPL_TOKEN_PROGRAM_ID,
      }),
    ],
  };
}

/**
 * The vault PDA's bump, which the instruction data carries as a public input.
 *
 * Zolana exports the address but not the bump, so this re-derives the PDA over
 * the seeds its `splInterfaceWithBump` pins and asserts the result matches the
 * exported address. That assertion is what makes the recovered bump
 * trustworthy: a seed or program-id drift upstream fails here instead of
 * producing a proof bound to an account the instruction never reaches.
 */
async function splAssetVaultBump(asset: Address): Promise<number> {
  const [derived, bump] = await getProgramDerivedAddress({
    programAddress: SHIELDED_POOL_PROGRAM_ID,
    seeds: [textEncoder.encode("spl_asset_vault"), addressEncoder.encode(asset)],
  });
  if (derived !== (await getSplAssetVaultAddress(asset))) {
    throw new HeliusRingsError(
      "config_error",
      "the Rings SPL vault derivation no longer matches the SDK's"
    );
  }
  return bump;
}
