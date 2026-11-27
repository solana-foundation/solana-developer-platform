import {
  isCustodyProviderInReleaseChannel,
  resolveSdpReleaseChannel,
} from "@sdp/types/release-channels";
import { z } from "zod";
import type { SafeProxyProvider } from "./endpoints/providers";

export const positiveInteger = z.coerce.number().int().positive();

export function readEnv<Settings extends z.ZodRawShape>(
  settings: Settings
): z.infer<z.ZodObject<Settings>> {
  const parsed = z.object(settings).safeParse(process.env);
  if (parsed.success) return parsed.data;
  const names = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
  throw new Error(`invalid settings: ${names.join(", ")}`);
}

export function providerTarget(url: string, provider: string, cluster: string): string | null {
  const { pathname, search } = new URL(url);
  const prefix = `/${provider}/${cluster}`;
  if (!pathname.startsWith(`${prefix}/`)) return null;
  return pathname.slice(prefix.length) + search;
}

export function inReleaseChannel(provider: SafeProxyProvider): boolean {
  return isCustodyProviderInReleaseChannel(
    resolveSdpReleaseChannel(process.env.SDP_RELEASE_CHANNEL),
    provider,
    "managed"
  );
}
