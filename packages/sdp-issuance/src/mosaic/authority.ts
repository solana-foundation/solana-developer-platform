import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import {
  getMintDetails,
  getRemoveAuthorityTransaction,
  getUpdateAuthorityTransaction,
  TOKEN_ACL_PROGRAM_ID,
} from "@solana/mosaic-sdk";
import { findMintConfigPda, getSetAuthorityInstruction } from "@solana/token-acl-sdk";
import { AuthorityType } from "@solana-program/token-2022";

/** Freeze operations use the ACL controller when the mint delegates freezing to ACL. */
export async function buildAuthorityTransaction(
  input: Omit<Parameters<typeof getUpdateAuthorityTransaction>[0], "newAuthority"> & {
    newAuthority: Parameters<typeof getUpdateAuthorityTransaction>[0]["newAuthority"] | null;
  },
  invalidArgument: (message: string) => Error = (message) => new Error(message)
) {
  if (input.role === AuthorityType.FreezeAccount) {
    const mint = await getMintDetails(input.rpc, input.mint);
    if (mint.usesTokenAcl) {
      if (input.newAuthority === null) {
        throw invalidArgument(
          "This token's freeze controller can be reassigned but cannot be removed."
        );
      }
      const [mintConfig] = await findMintConfigPda(
        { mint: input.mint },
        { programAddress: TOKEN_ACL_PROGRAM_ID }
      );
      const instruction = getSetAuthorityInstruction(
        { authority: input.currentAuthority, mintConfig, newAuthority: input.newAuthority },
        { programAddress: TOKEN_ACL_PROGRAM_ID }
      );
      const { value: blockhash } = await input.rpc.getLatestBlockhash().send();
      return pipe(
        createTransactionMessage({ version: 0 }),
        (message) => setTransactionMessageFeePayerSigner(input.payer, message),
        (message) => setTransactionMessageLifetimeUsingBlockhash(blockhash, message),
        (message) => appendTransactionMessageInstructions([instruction], message)
      );
    }
  }
  return input.newAuthority === null
    ? getRemoveAuthorityTransaction(input)
    : getUpdateAuthorityTransaction({ ...input, newAuthority: input.newAuthority });
}
