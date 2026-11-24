import { SignerErrorCode } from "@solana/keychain-core";
import { createFireblocksSigner } from "@solana/keychain-fireblocks";
import { z } from "zod";

// The error class is local to the SDK's keychain-core version.
const credentialErrorSchema = z.object({
  code: z.string(),
  context: z.object({ status: z.number().optional() }).optional(),
});

/** One authenticated address read. Never exposes a signer or proposes a transaction. */
export async function checkFireblocksCredential(
  input: Parameters<typeof createFireblocksSigner>[0]
): Promise<{ status: "success"; address: string } | { status: "failed" | "retry_unknown" }> {
  try {
    const signer = await createFireblocksSigner(input);
    return { status: "success", address: signer.address };
  } catch (error) {
    const parsed = credentialErrorSchema.safeParse(error);
    if (
      parsed.success &&
      (parsed.data.code === SignerErrorCode.INVALID_PRIVATE_KEY ||
        (parsed.data.code === SignerErrorCode.REMOTE_API_ERROR &&
          [401, 403, 404].includes(Number(parsed.data.context?.status))))
    )
      return { status: "failed" };
    return { status: "retry_unknown" };
  }
}
