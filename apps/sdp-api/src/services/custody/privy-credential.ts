import { hashString } from "@sdp/payments/hash";
import type { Env } from "@/types/env";

export const PRIVY_RUNTIME_ENV_FIELDS = {
  appId: "PRIVY_APP_ID",
  appSecret: "PRIVY_APP_SECRET",
} as const satisfies Record<string, keyof Env & string>;

export async function getPrivyProviderAccountFingerprint(appId: string): Promise<string> {
  return `sha256:${await hashString(appId.trim())}`;
}
