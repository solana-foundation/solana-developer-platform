import {
  AccountRole,
  address,
  addSignersToTransactionMessage,
  appendTransactionMessageInstruction,
  blockhash,
  createTransactionMessage,
  generateKeyPairSigner,
  getTransactionDecoder,
  getTransactionEncoder,
  partiallySignTransactionMessageWithSigners,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "@/test/helpers/env";
import {
  type PreparedStrategySigningTarget,
  signPreparedStrategyTransaction,
} from "./strategy-transactions.service";
import { verifySignedWalletTransaction } from "./vault-wallet.service";

const resolveSigner = vi.hoisted(() => vi.fn());
vi.mock("@/services/solana/signer", () => ({
  createOrgSignerForCustodyWallet: resolveSigner,
}));

const scope = {
  organizationId: "org_signing",
  projectId: "prj_signing",
  custodyWalletId: "wallet",
};

async function preparedProviderTransaction(owner: string): Promise<PreparedStrategySigningTarget> {
  const protocol = await generateKeyPairSigner();
  const message = appendTransactionMessageInstruction(
    {
      programAddress: address("11111111111111111111111111111111"),
      accounts: [
        { address: address(owner), role: AccountRole.READONLY_SIGNER },
        { address: protocol.address, role: AccountRole.READONLY_SIGNER },
      ],
      data: Uint8Array.of(1),
    },
    setTransactionMessageLifetimeUsingBlockhash(
      {
        blockhash: blockhash("29d2S7vB453rNYFdR5Ycwt7y9haRT5fwVwL9zTmBhfV2"),
        lastValidBlockHeight: 999n,
      },
      setTransactionMessageFeePayer(address(owner), createTransactionMessage({ version: 0 }))
    )
  );
  const transaction = await partiallySignTransactionMessageWithSigners(
    addSignersToTransactionMessage([protocol], message)
  );
  return {
    id: "prepared_strategy_transaction",
    owner_address: owner,
    unsigned_transaction: Buffer.from(getTransactionEncoder().encode(transaction)).toString(
      "base64"
    ),
    last_valid_block_height: "999",
    fee_mode: "wallet",
    fee_payer: null,
    movement: "earn.withdraw",
  };
}

beforeEach(() => resolveSigner.mockReset());

describe("prepared strategy custody signing", () => {
  it("signs the exact prepared message while preserving every provider signature", async () => {
    const owner = await generateKeyPairSigner();
    resolveSigner.mockResolvedValue(owner);
    const built = await preparedProviderTransaction(owner.address);
    const signed = await signPreparedStrategyTransaction(env, scope, built);
    const before = getTransactionDecoder().decode(
      Buffer.from(built.unsigned_transaction, "base64")
    );
    const after = getTransactionDecoder().decode(Buffer.from(signed, "base64"));

    expect(after.messageBytes).toEqual(before.messageBytes);
    for (const [signer, signature] of Object.entries(before.signatures)) {
      if (signature !== null) expect(after.signatures[address(signer)]).toEqual(signature);
    }
    expect(after.signatures[owner.address]).not.toBeNull();
    await expect(verifySignedWalletTransaction(built, signed)).resolves.toMatchObject({
      signedTransactionBase64: signed,
    });
    expect(resolveSigner).toHaveBeenCalledWith(
      env,
      scope.organizationId,
      scope.projectId,
      scope.custodyWalletId,
      "earn.withdraw"
    );
  });

  it("refuses a custody wallet whose resolved owner no longer matches preparation", async () => {
    const [owner, other] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner()]);
    resolveSigner.mockResolvedValue(other);
    await expect(
      signPreparedStrategyTransaction(env, scope, await preparedProviderTransaction(owner.address))
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("keeps owner-address signing outside SDP", async () => {
    const owner = await generateKeyPairSigner();
    await expect(
      signPreparedStrategyTransaction(
        env,
        { ...scope, custodyWalletId: null },
        await preparedProviderTransaction(owner.address)
      )
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
    expect(resolveSigner).not.toHaveBeenCalled();
  });
});
