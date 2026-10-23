import { createPrivateKey } from "node:crypto";
import { checkFireblocksCredential } from "@sdp/custody/provisioning/fireblocks-credential";
import { hashString } from "@sdp/payments/hash";
import type { SdpEnvironment } from "@sdp/types/api-keys";
import type { ByokCustodyProvider } from "@sdp/types/custody";
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

export const byokRegistrationSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("privy"), fields: privyAuthenticationSchema }).strict(),
  z.object({ provider: z.literal("fireblocks"), fields: fireblocksRegistrationSchema }).strict(),
]);
export type ByokRegistration = z.infer<typeof byokRegistrationSchema>;
export type ByokCredentialFields = ByokRegistration["fields"];

export type ByokCredentialSecretFields =
  | z.infer<typeof privyAuthenticationSchema>
  | z.infer<typeof fireblocksAuthenticationSchema>;
export const byokCredentialAuthenticationSchema = z.discriminatedUnion("provider", [
  privyAuthenticationSchema.extend({ provider: z.literal("privy") }),
  fireblocksAuthenticationSchema.extend({
    provider: z.literal("fireblocks"),
    assetId: z.enum(["SOL", "SOL_TEST"]),
  }),
]);
export type ByokCredentialAuthentication = z.infer<typeof byokCredentialAuthenticationSchema>;

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
  // The stored provider owns dispatch; a payload cannot override its discriminator.
  const parsed = byokCredentialAuthenticationSchema.safeParse({ ...payload, provider });
  if (parsed.success) return parsed.data;
  throw internalError("Custody credential payload is unavailable");
}

export function credentialDisplayMetadata(fields: ByokCredentialFields): {
  appIdSuffix?: string;
  apiKeySuffix?: string;
  primaryVaultId?: string;
} {
  if ("appId" in fields)
    return { appIdSuffix: fields.appId.length > 4 ? fields.appId.slice(-4) : undefined };
  return {
    apiKeySuffix: fields.apiKey.length > 4 ? fields.apiKey.slice(-4) : undefined,
    primaryVaultId: fields.vaultAccountId,
  };
}

export const byokCredentialCheckSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("success"),
      fingerprint: z.string().min(1),
      wallet: z
        .object({ walletId: z.string().min(1), address: z.string().min(1) })
        .strict()
        .optional(),
    })
    .strict(),
  z.object({ status: z.enum(["failed", "retry_unknown"]) }).strict(),
]);
export type ByokCredentialCheck = z.infer<typeof byokCredentialCheckSchema>;

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
  const result = await checkFireblocksCredential({
    apiKey: credential.apiKey,
    privateKeyPem: credential.apiSecretPem,
    vaultAccountId: credential.vaultAccountId,
    assetId: credential.assetId,
    apiBaseUrl: env.FIREBLOCKS_API_BASE_URL,
  });
  if (result.status !== "success") return result;
  // Vault numbers repeat across workspaces; bind rotation to the actual address.
  const fingerprint = `sha256:${await hashString(JSON.stringify(["fireblocks", credential.assetId, credential.vaultAccountId, result.address]))}`;
  return {
    status: "success",
    fingerprint,
    wallet: { walletId: `fb_${credential.vaultAccountId}`, address: result.address },
  };
}
