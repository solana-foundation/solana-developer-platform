import { z } from "zod";

const port = z.coerce.number().int().min(1).max(65535);
const positiveInteger = z
  .string()
  .regex(/^[1-9][0-9]{0,8}$/)
  .transform(Number);

// The key may arrive on one line with its line breaks written as `\n`.
const pkcs8PrivateKey = z
  .string()
  .transform((value) => value.replace(/\\n/g, "\n").trim())
  .pipe(z.string().regex(/^-----BEGIN PRIVATE KEY-----\n[\s\S]+\n-----END PRIVATE KEY-----$/));

const PLATFORM_REQUEST_TIMEOUT_MS = 300_000;
const IDENTITY_TOKEN_LIFETIME_SECONDS = 3600;

const sharedSettings = {
  SAFE_PROXY_MAX_BUDGET_MS: positiveInteger.pipe(z.number().lt(PLATFORM_REQUEST_TIMEOUT_MS)),
  PRIVY_APP_ID: z.string().min(1),
  PRIVY_APP_SECRET: z.string().min(1),
  FIREBLOCKS_API_KEY: z.string().min(1),
  FIREBLOCKS_API_SECRET: pkcs8PrivateKey,
};

const serverSettingsSchema = z
  .object({
    ...sharedSettings,
    PORT: port,
    K_REVISION: z.string().min(1),
    SAFE_PROXY_AUDIENCE: z.url({ protocol: /^https$/ }),
    SAFE_PROXY_API_CALLER: z.email(),
    SAFE_PROXY_CRON_CALLER: z.email(),
    SAFE_PROXY_MAX_TOKEN_AGE_SECONDS: positiveInteger.pipe(
      z.number().max(IDENTITY_TOKEN_LIFETIME_SECONDS)
    ),
  })
  .refine((settings) => settings.SAFE_PROXY_API_CALLER !== settings.SAFE_PROXY_CRON_CALLER, {
    path: ["SAFE_PROXY_CRON_CALLER"],
  });

const localSettingsSchema = z.object({
  ...sharedSettings,
  SDP_SAFE_PROXY_PORT: port,
});

export type ServerSettings = z.infer<typeof serverSettingsSchema>;
export type LocalSettings = z.infer<typeof localSettingsSchema>;

type Env = Record<string, string | undefined>;

function parse<Settings>(schema: z.ZodType<Settings>, env: Env): Settings {
  const parsed = schema.safeParse(env);
  if (parsed.success) return parsed.data;
  // Names the settings that failed, never Zod's message or the value.
  const names = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))];
  throw new Error(`invalid settings: ${names.join(", ")}`);
}

export function parseServerSettings(env: Env): ServerSettings {
  return parse(serverSettingsSchema, env);
}

export function parseLocalSettings(env: Env): LocalSettings {
  return parse(localSettingsSchema, env);
}
