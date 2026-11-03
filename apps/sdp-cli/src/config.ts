import { DEFAULT_SDP_API_URL } from "@sdp/types/site";
import { z } from "zod";
import type { Operation } from "./contract";
import { usageError } from "./errors";

const credential = z
  .string()
  .min(1)
  .regex(/^[\x21-\x7E]+$/, "Credential must use printable ASCII without whitespace");
const configSchema = z.object({
  apiUrl: z.url().transform((value, ctx) => {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) {
      ctx.addIssue({
        code: "custom",
        message: "API URL cannot contain credentials, a query, or a fragment",
      });
    }
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    ) {
      ctx.addIssue({
        code: "custom",
        message: "API URL must use HTTPS (HTTP is allowed on loopback)",
      });
    }
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
    return url.toString();
  }),
  auth: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("api-key"), credential }),
    z.object({ kind: z.literal("session"), credential }),
    z.object({ kind: z.literal("payment-link") }),
    z.object({ kind: z.literal("public") }),
    z.object({ kind: z.literal("webhook") }),
  ]),
  projectId: z.string().trim().min(1).optional(),
  organizationId: z.string().trim().min(1).optional(),
  timeoutMs: z.coerce.number().int().min(1).max(2_147_483_647),
});

export type Config = z.infer<typeof configSchema>;
export interface GlobalOptions {
  "api-url"?: string;
  "api-key"?: string;
  token?: string;
  project?: string;
  organization?: string;
  "timeout-ms"?: string;
}

/** Public, link, and signed-ingress operations omit account credentials and tenant selectors. */
export function resolveConfig(
  options: GlobalOptions,
  env: NodeJS.ProcessEnv,
  authorization: Operation["authorization"]
): Config {
  let auth: Config["auth"];
  if (
    authorization.kind === "payment-link" ||
    authorization.kind === "public" ||
    authorization.kind === "webhook"
  ) {
    auth = { kind: authorization.kind };
  } else {
    const explicit = options["api-key"] !== undefined || options.token !== undefined;
    const apiKey = explicit ? options["api-key"] : env.SDP_API_KEY;
    const token = explicit ? options.token : env.SDP_TOKEN;
    if (apiKey !== undefined && token !== undefined)
      usageError("Set one of --api-key / SDP_API_KEY or --token / SDP_TOKEN.");
    if (apiKey !== undefined) auth = { kind: "api-key", credential: apiKey };
    else {
      if (token === undefined)
        usageError(
          "Authentication required. Set SDP_API_KEY or SDP_TOKEN (a Clerk session token)."
        );
      auth = { kind: "session", credential: token };
    }
  }
  const accountAuth = auth.kind === "api-key" || auth.kind === "session";
  const result = configSchema.safeParse({
    apiUrl: options["api-url"] ?? env.SDP_API_URL ?? DEFAULT_SDP_API_URL,
    auth,
    projectId: accountAuth ? (options.project ?? env.SDP_PROJECT_ID) : undefined,
    organizationId: accountAuth ? (options.organization ?? env.SDP_ORGANIZATION_ID) : undefined,
    timeoutMs: options["timeout-ms"] ?? env.SDP_TIMEOUT_MS ?? "30000",
  });
  if (!result.success) {
    usageError(
      result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
    );
  }
  return result.data;
}
