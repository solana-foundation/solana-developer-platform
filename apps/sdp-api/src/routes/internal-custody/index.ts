import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "@/db";
import { getAuth } from "@/lib/auth";
import { badRequest } from "@/lib/errors";
import { created, success } from "@/lib/response";
import { credentialAdminAuthMiddleware } from "@/middleware/credential-admin-auth";
import { idempotencyKeyMiddleware } from "@/middleware/idempotency-key";
import { projectContextMiddleware } from "@/middleware/project-context";
import { getCustodySetupStatus } from "@/services/custody-setup-status.service";
import { checkProviderCredential } from "@/services/provider-credential-check.service";
import { submitProviderCredential } from "@/services/provider-credential-submission.service";
import type { Env } from "@/types/env";

const privyCredentialSubmissionSchema = z
  .object({
    provider: z.literal("privy"),
    walletLabel: z.string().trim().min(1).max(100).optional(),
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

// What is installed per provider for this scope: legacy config presence, the
// record that actually backs signing, and connection lifecycle counts. Internal
// on purpose — it drives dashboard setup flows only, so it commits to no public
// OpenAPI or API-key authorization contract while the setup model evolves.
internalCustody.get("/providers", async (c) => {
  const auth = getAuth(c);
  return success(
    c,
    await getCustodySetupStatus(getDb(c.env), auth.organizationId, c.get("projectId"))
  );
});

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

internalCustody.post("/provider-credentials/:providerCredentialId/check", async (c) => {
  return success(c, await checkProviderCredential(c, c.req.param("providerCredentialId")));
});

export default internalCustody;
