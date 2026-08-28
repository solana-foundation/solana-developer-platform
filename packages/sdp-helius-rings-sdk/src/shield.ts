import type { ZolanaClient } from "@heliuslabs/zolana/client";
import { buildDepositTransaction } from "@heliuslabs/zolana/wallet";
import { HeliusRingsError } from "@sdp/helius-rings";
import { address, getBase64Codec, getTransactionEncoder } from "@solana/kit";
import { protocolMint } from "./flows/mint.js";
import { assertProvisionedIdentity, type ShieldedMaterialSource } from "./material.js";

/**
 * Builds an unsigned public-to-private deposit. A shield creates a note rather
 * than spending one, so there is no prover call and no wallet sync; the owner's
 * signature on the outer transaction is the whole of the authorization.
 */

export interface ShieldDeps {
  readonly client: ZolanaClient;
  readonly material: ShieldedMaterialSource;
  readonly organizationId: string;
  readonly projectId: string;
}

export interface ShieldInput {
  readonly walletId: string;
  readonly owner: string;
  readonly mint: string;
  readonly amountRaw: string;
  /** The identity provisioning published. A mismatch fails closed. */
  readonly expectedShieldedAddress: string;
}

const UINT64_MAX = 0xffff_ffff_ffff_ffffn;

export async function buildShieldTransaction(
  deps: ShieldDeps,
  input: ShieldInput
): Promise<string> {
  const owner = parseAddress(input.owner, "owner");
  const asset = parseAddress(protocolMint(input.mint), "mint");
  const amount = parsePositiveAmount(input.amountRaw);

  return deps.material.withMaterial(
    {
      organizationId: deps.organizationId,
      projectId: deps.projectId,
      walletId: input.walletId,
      owner: input.owner,
    },
    async (material) => {
      assertProvisionedIdentity(material, input.expectedShieldedAddress);

      const transaction = await buildDepositTransaction({
        client: deps.client,
        feePayer: owner,
        depositor: owner,
        recipient: material.shieldedAddress,
        asset,
        amount,
      });

      return getBase64Codec().decode(getTransactionEncoder().encode(transaction));
    }
  );
}

function parseAddress(value: string, field: string): ReturnType<typeof address> {
  try {
    return address(value);
  } catch {
    throw new HeliusRingsError("invalid_input", `the Rings shield ${field} is not a valid address`);
  }
}

function parsePositiveAmount(amountRaw: string): bigint {
  if (!/^[1-9]\d*$/.test(amountRaw)) {
    throw new HeliusRingsError(
      "invalid_input",
      "the Rings shield amount must be a positive integer"
    );
  }

  const amount = BigInt(amountRaw);
  if (amount > UINT64_MAX) {
    throw new HeliusRingsError("invalid_input", "the Rings shield amount exceeds uint64");
  }
  return amount;
}
