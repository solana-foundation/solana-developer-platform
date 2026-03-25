import { createVercelAdapter } from "@flags-sdk/vercel";
import { flag } from "flags/next";
import { getDefaultAuthEntryEnabled } from "@/lib/auth-entry-config";

const defaultValue = getDefaultAuthEntryEnabled();
const flagsSdkKey = process.env.FLAGS?.trim();

export const clerkAuthEntry = flag<boolean>({
  key: "clerk-auth-entry",
  ...(flagsSdkKey
    ? { adapter: createVercelAdapter(flagsSdkKey)() }
    : { decide: () => defaultValue }),
  defaultValue,
  description:
    "Controls whether Clerk sign-in and sign-up entry points are enabled for unauthenticated users.",
  options: [
    { value: false, label: "Disabled" },
    { value: true, label: "Enabled" },
  ],
});
