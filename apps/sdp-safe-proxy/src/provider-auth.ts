import { createHash, randomUUID } from "node:crypto";
import type { SafeProxyProvider } from "@sdp/safe-proxy-endpoints/providers";
import { importPKCS8, SignJWT } from "jose";

export interface ProviderCredentials {
  fireblocks: { apiKey: string; apiSecretPem: string };
  privy: { appId: string; appSecret: string };
}

interface AuthRequest {
  // The request target as it is sent: path, then an optional query.
  path: string;
  // The body as it is sent; empty when the request has none.
  body: string;
}

const FIREBLOCKS_TOKEN_LIFETIME_SECONDS = 30;

// The token covers the exact target and body in the request, so both must be forwarded as given
// here.
async function fireblocksAuth(
  credential: ProviderCredentials["fireblocks"],
  request: AuthRequest
): Promise<Record<string, string>> {
  const privateKey = await importPKCS8(credential.apiSecretPem, "RS256");
  const bodyHash = createHash("sha256").update(request.body, "utf8").digest("hex");
  const now = Math.floor(Date.now() / 1000);

  const token = await new SignJWT({ bodyHash, nonce: randomUUID(), uri: request.path })
    .setProtectedHeader({ alg: "RS256" })
    .setSubject(credential.apiKey)
    .setIssuedAt(now)
    .setExpirationTime(now + FIREBLOCKS_TOKEN_LIFETIME_SECONDS)
    .sign(privateKey);

  return { Authorization: `Bearer ${token}`, "X-API-Key": credential.apiKey };
}

function privyAuth(credential: ProviderCredentials["privy"]): Record<string, string> {
  const basic = Buffer.from(`${credential.appId}:${credential.appSecret}`, "utf8");
  return { Authorization: `Basic ${basic.toString("base64")}`, "privy-app-id": credential.appId };
}

export async function authHeaders(
  provider: SafeProxyProvider,
  credentials: ProviderCredentials,
  request: AuthRequest
): Promise<Record<string, string>> {
  switch (provider) {
    case "fireblocks":
      return fireblocksAuth(credentials.fireblocks, request);
    case "privy":
      return privyAuth(credentials.privy);
    default: {
      const unreachable: never = provider;
      return unreachable;
    }
  }
}
