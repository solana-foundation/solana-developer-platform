import { z } from "zod";

const port = z.coerce.number().int().min(1).max(65535);

const environmentSchema = z.discriminatedUnion("SAFE_PROXY_CALLER_AUTH", [
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

const settingsSchema = environmentSchema
  .refine(
    (environment) =>
      environment.SAFE_PROXY_CALLER_AUTH === "local" ||
      environment.SAFE_PROXY_API_CALLER_EMAIL !== environment.SAFE_PROXY_CRON_CALLER_EMAIL,
    "SAFE_PROXY_API_CALLER_EMAIL and SAFE_PROXY_CRON_CALLER_EMAIL must name different accounts"
  )
  .transform((environment) =>
    environment.SAFE_PROXY_CALLER_AUTH === "local"
      ? { callerAuth: "local" as const, port: environment.PORT }
      : {
          callerAuth: "google" as const,
          port: environment.PORT,
          audience: environment.SAFE_PROXY_AUDIENCE,
          callerEmails: {
            api: environment.SAFE_PROXY_API_CALLER_EMAIL,
            cron: environment.SAFE_PROXY_CRON_CALLER_EMAIL,
          },
        }
  );

export type Settings = z.infer<typeof settingsSchema>;

/** Reads the settings once at start-up. A missing or wrong setting throws, which stops the start. */
export function readSettings(env: NodeJS.ProcessEnv): Settings {
  return settingsSchema.parse(env);
}
