import {
  getDefaultSignInEntryEnabled,
  getDefaultSignUpEntryEnabled,
} from "@/lib/auth-entry-config";
import { createVercelAdapter } from "@flags-sdk/vercel";
import { flag } from "flags/next";

const flagsSdkKey = process.env.FLAGS?.trim();
const adapterFactory = flagsSdkKey ? createVercelAdapter(flagsSdkKey) : null;

function createAuthEntryFlag(params: {
  defaultValue: boolean;
  description: string;
  key: string;
}) {
  return flag<boolean>({
    key: params.key,
    adapter: adapterFactory ? adapterFactory<boolean, any>() : undefined,
    decide: () => params.defaultValue,
    defaultValue: params.defaultValue,
    description: params.description,
    options: [
      { value: false, label: "Disabled" },
      { value: true, label: "Enabled" },
    ],
  });
}

export const clerkSignInEntry = createAuthEntryFlag({
  key: "clerk-sign-in-entry",
  defaultValue: getDefaultSignInEntryEnabled(),
  description: "Controls whether Clerk sign-in entry is enabled for unauthenticated users.",
});

export const clerkSignUpEntry = createAuthEntryFlag({
  key: "clerk-sign-up-entry",
  defaultValue: getDefaultSignUpEntryEnabled(),
  description: "Controls whether Clerk sign-up entry is enabled for unauthenticated users.",
});
