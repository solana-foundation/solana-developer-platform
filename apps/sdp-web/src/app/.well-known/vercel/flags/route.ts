import * as flags from "@/flags";
import { getProviderData } from "@flags-sdk/vercel";
import {
  createFlagsDiscoveryEndpoint,
  getProviderData as getFallbackProviderData,
} from "flags/next";

export const GET = createFlagsDiscoveryEndpoint(async () => {
  return process.env.FLAGS?.trim() ? getProviderData(flags) : getFallbackProviderData(flags);
});
