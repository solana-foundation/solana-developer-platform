import { z } from "zod";

const port = z.coerce.number().int().min(1).max(65535);

const settingsSchema = z.discriminatedUnion("SAFE_PROXY_CALLER_AUTH", [
  z.object({
    SAFE_PROXY_CALLER_AUTH: z.literal("google"),
    PORT: port,
    SAFE_PROXY_AUDIENCE: z.url({ protocol: /^https$/ }),
    SAFE_PROXY_API_CALLER_EMAIL: z.email(),
    SAFE_PROXY_CRON_CALLER_EMAIL: z.email(),
  }),
  z.object({
    SAFE_PROXY_CALLER_AUTH: z.literal("local"),
    PORT: port,
    // Cloud Run sets K_SERVICE on every instance, so the local caller check cannot start there.
    K_SERVICE: z
      .undefined({ error: "SAFE_PROXY_CALLER_AUTH=local cannot run on Cloud Run" })
      .optional(),
  }),
]);

export type Settings =
  | {
      callerAuth: "google";
      port: number;
      audience: string;
      callerEmails: { api: string; cron: string };
    }
  | { callerAuth: "local"; port: number };

/** Reads the settings once at start-up. A missing or wrong setting throws, which stops the start. */
export function readSettings(env: NodeJS.ProcessEnv): Settings {
  const parsed = settingsSchema.parse(env);
  if (parsed.SAFE_PROXY_CALLER_AUTH === "local") {
    return { callerAuth: "local", port: parsed.PORT };
  }
  if (parsed.SAFE_PROXY_API_CALLER_EMAIL === parsed.SAFE_PROXY_CRON_CALLER_EMAIL) {
    throw new Error(
      "SAFE_PROXY_API_CALLER_EMAIL and SAFE_PROXY_CRON_CALLER_EMAIL must name different accounts"
    );
  }
  return {
    callerAuth: "google",
    port: parsed.PORT,
    audience: parsed.SAFE_PROXY_AUDIENCE,
    callerEmails: {
      api: parsed.SAFE_PROXY_API_CALLER_EMAIL,
      cron: parsed.SAFE_PROXY_CRON_CALLER_EMAIL,
    },
  };
}
