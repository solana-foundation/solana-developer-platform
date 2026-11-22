import type { AuthHeaders } from "./injection";

export interface PrivyCredential {
  appId: string;
  appSecret: string;
}

export function privyAuthHeaders(credential: PrivyCredential): AuthHeaders {
  const basic = Buffer.from(`${credential.appId}:${credential.appSecret}`, "utf8");
  return {
    Authorization: `Basic ${basic.toString("base64")}`,
    "privy-app-id": credential.appId,
  };
}
