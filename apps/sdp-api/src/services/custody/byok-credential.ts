import { createPrivateKey } from "node:crypto";
import { hashString } from "@sdp/payments/hash";
import type { ByokCustodyProvider, SdpEnvironment } from "@sdp/types";
import { SignerError, SignerErrorCode } from "@solana/keychain-core";
import { FireblocksSigner } from "@solana/keychain-fireblocks";
import { z } from "zod";
import { badRequest, internalError } from "@/lib/errors";
import {
  checkPrivyCredential,
  getPrivyProviderAccountFingerprint,
} from "@/services/custody/privy-credential";
import type { Env } from "@/types/env";

export const privyAuthenticationSchema = z
  .object({
    appId: z.string().trim().min(1).max(4096),
    appSecret: z.string().min(1).max(4096),
  })
  .strict();

export const fireblocksAuthenticationSchema = z
  .object({
    apiKey: z.string().trim().min(1).max(4096),
    apiSecretPem: z.string().trim().min(1).max(16384),
    vaultAccountId: z.string().trim().regex(/^\d+$/).max(100),
  })
  .strict();

export const fireblocksRegistrationSchema = fireblocksAuthenticationSchema
  .omit({ apiSecretPem: true })
  .extend({ signingKeyId: z.string().regex(/^fbcsr_[a-f0-9-]{36}$/) })
  .strict();

export type ByokCredentialFields =
  | z.infer<typeof privyAuthenticationSchema>
  | z.infer<typeof fireblocksRegistrationSchema>;

export type ByokCredentialSecretFields =
  | z.infer<typeof privyAuthenticationSchema>
  | z.infer<typeof fireblocksAuthenticationSchema>;
export type ByokCredentialAuthentication =
  | ({ provider: "privy" } & z.infer<typeof privyAuthenticationSchema>)
  | ({ provider: "fireblocks"; assetId: "SOL" | "SOL_TEST" } & z.infer<
      typeof fireblocksAuthenticationSchema
    >);

/** Accept PKCS#1 and PKCS#8 exports, then store the PKCS#8 form keychain consumes. */
export function credentialPayload(
  provider: ByokCustodyProvider,
  fields: ByokCredentialSecretFields,
  environment: SdpEnvironment | undefined
): Record<string, string> {
  const parsed = (
    provider === "privy" ? privyAuthenticationSchema : fireblocksAuthenticationSchema
  ).safeParse(fields);
  if (!parsed.success) throw badRequest("Invalid provider credential fields");
  if ("appId" in parsed.data) return parsed.data;
  if (!environment) throw internalError("Project environment is required");
  let apiSecretPem: string;
  try {
    const key = createPrivateKey(parsed.data.apiSecretPem.replace(/\\n/g, "\n"));
    if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048)
      throw new Error("Invalid RSA key");
    apiSecretPem = key.export({ type: "pkcs8", format: "pem" }).toString();
  } catch {
    throw badRequest("Fireblocks requires an unencrypted RSA private key in PEM format");
  }
  return {
    ...parsed.data,
    apiSecretPem,
    assetId: environment === "production" ? "SOL" : "SOL_TEST",
  };
}

/** Never infer a provider from fields or fall back to deployment credentials. */
export function parseByokCredential(
  provider: string,
  payload: Record<string, unknown>
): ByokCredentialAuthentication {
  if (provider === "privy") {
    const parsed = privyAuthenticationSchema.safeParse(payload);
    if (parsed.success) return { provider, ...parsed.data };
  }
  if (provider === "fireblocks") {
    const parsed = fireblocksAuthenticationSchema
      .extend({ assetId: z.enum(["SOL", "SOL_TEST"]) })
      .safeParse(payload);
    if (parsed.success) return { provider, ...parsed.data };
  }
  throw internalError("Custody credential payload is unavailable");
}

export function credentialDisplayMetadata(fields: ByokCredentialFields): {
  appIdSuffix?: string;
  apiKeySuffix?: string;
} {
  return "appId" in fields
    ? fields.appId.length > 4
      ? { appIdSuffix: fields.appId.slice(-4) }
      : {}
    : fields.apiKey.length > 4
      ? { apiKeySuffix: fields.apiKey.slice(-4) }
      : {};
}

export type ByokCredentialCheck =
  | { status: "success"; fingerprint: string; wallet?: { walletId: string; address: string } }
  | { status: "failed" | "retry_unknown" };

/** One authenticated provider read; checking a Fireblocks connection never proposes a signature. */
export async function checkByokCredential(
  env: Env,
  credential: ByokCredentialAuthentication
): Promise<ByokCredentialCheck> {
  if (credential.provider === "privy") {
    const status = await checkPrivyCredential(env, credential);
    return status === "success"
      ? { status, fingerprint: await getPrivyProviderAccountFingerprint(credential.appId) }
      : { status };
  }
  try {
    const signer = await FireblocksSigner.create({
      apiKey: credential.apiKey,
      privateKeyPem: credential.apiSecretPem,
      vaultAccountId: credential.vaultAccountId,
      assetId: credential.assetId,
      apiBaseUrl: env.FIREBLOCKS_API_BASE_URL,
    });
    // Vault numbers repeat across workspaces. Bind continuity to the actual
    // Solana address as well, never the API user ID (which changes on rotation).
    const fingerprint = `sha256:${await hashString(JSON.stringify(["fireblocks", credential.assetId, credential.vaultAccountId, signer.address]))}`;
    return {
      status: "success",
      fingerprint,
      wallet: { walletId: `fb_${credential.vaultAccountId}`, address: signer.address },
    };
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
