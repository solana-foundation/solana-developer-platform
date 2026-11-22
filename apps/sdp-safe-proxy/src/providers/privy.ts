import { type AuthHeaders, AuthService } from "./auth-service";

export interface PrivyCredential {
  appId: string;
  appSecret: string;
}

export class PrivyAuthService extends AuthService<PrivyCredential> {
  injectCredentials(credential: PrivyCredential): AuthHeaders {
    const basic = Buffer.from(`${credential.appId}:${credential.appSecret}`, "utf8");
    return {
      Authorization: `Basic ${basic.toString("base64")}`,
      "privy-app-id": credential.appId,
    };
  }
}
