import { SignerError, SignerErrorCode } from "@solana/keychain-core";
import { FireblocksSigner } from "@solana/keychain-fireblocks";

/** One authenticated address read. Never exposes a signer or proposes a transaction. */
export async function checkFireblocksCredential(
  input: Parameters<typeof FireblocksSigner.create>[0]
): Promise<{ status: "success"; address: string } | { status: "failed" | "retry_unknown" }> {
  try {
    const signer = await FireblocksSigner.create(input);
    return { status: "success", address: signer.address };
  } catch (error) {
    if (
      error instanceof SignerError &&
      (error.code === SignerErrorCode.INVALID_PRIVATE_KEY ||
        (error.code === SignerErrorCode.REMOTE_API_ERROR &&
          [401, 403, 404].includes(Number(error.context?.status))))
    )
      return { status: "failed" };
    return { status: "retry_unknown" };
  }
}
