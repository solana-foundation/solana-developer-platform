import { Hono } from "hono";
import { z } from "zod";
import { badRequest } from "@/lib/errors";
import { created } from "@/lib/response";
import { credentialAdminAuthMiddleware } from "@/middleware/credential-admin-auth";
import { idempotencyKeyMiddleware } from "@/middleware/idempotency-key";
import { projectContextMiddleware } from "@/middleware/project-context";
import { submitProviderCredential } from "@/services/provider-credential-submission.service";
import type { Env } from "@/types/env";

const privyCredentialSubmissionSchema = z
  .object({
    provider: z.literal("privy"),
    fields: z
      .object({
        credentialLabel: z.string().trim().min(1),
        scope: z.enum(["organization", "project"]),
        appId: z.string().trim().min(1),
        appSecret: z.string().min(1),
      })
      .strict(),
  })
  .strict();

const internalCustody = new Hono<{ Bindings: Env }>();

internalCustody.use("*", credentialAdminAuthMiddleware());
internalCustody.use("*", projectContextMiddleware());
internalCustody.use("*", idempotencyKeyMiddleware());

internalCustody.post("/provider-credentials", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = privyCredentialSubmissionSchema.safeParse(body);
  if (!parsed.success) {
    throw badRequest("Invalid request body", {
      errors: z.flattenError(parsed.error).fieldErrors,
    });
  }

  const idempotencyKey = c.req.header("Idempotency-Key");
  if (!idempotencyKey) {
    throw badRequest("Idempotency-Key is required");
  }

  const result = await submitProviderCredential(c, parsed.data, idempotencyKey);
  return created(c, result);
});

export default internalCustody;
