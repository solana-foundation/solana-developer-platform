import { createHash, randomUUID } from "node:crypto";
import { importPKCS8, SignJWT } from "jose";
import type { AuthHeaders, InjectionRequest } from "./injection";

export interface FireblocksCredential {
  apiKey: string;
  apiSecretPem: string;
}

const TOKEN_LIFETIME_SECONDS = 30;

// The token covers the exact target and body bytes in the request, so both
// must be forwarded as given here.
export async function fireblocksAuthHeaders(
  credential: FireblocksCredential,
  request: InjectionRequest
): Promise<AuthHeaders> {
  const privateKey = await importPKCS8(credential.apiSecretPem, "RS256");
  const bodyHash = createHash("sha256").update(request.body, "utf8").digest("hex");
  const now = Math.floor(Date.now() / 1000);

  const token = await new SignJWT({ bodyHash, nonce: randomUUID(), uri: request.path })
    .setProtectedHeader({ alg: "RS256" })
    .setSubject(credential.apiKey)
    .setIssuedAt(now)
    .setExpirationTime(now + TOKEN_LIFETIME_SECONDS)
    .sign(privateKey);

  return {
    Authorization: `Bearer ${token}`,
    "X-API-Key": credential.apiKey,
  };
}
