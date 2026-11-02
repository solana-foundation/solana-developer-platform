import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { EARN_ONBOARDING_STATES } from "@sdp/types/earn-onboarding";
import { z } from "zod";
import { errorResponseSchema, successResponseSchema } from "@/openapi/schemas/base";
import {
  onboardingApplicationSchema,
  onboardingCorrectionBodySchema,
  onboardingCorrectionParamsSchema,
  onboardingFormParamsSchema,
  onboardingParamsSchema,
  onboardingUploadSchema,
  onboardingWalletSchema,
} from "@/routes/earn-onboarding/schemas";
import {
  errorResponses,
  jsonContent,
  projectScopeHeaders,
  projectScopeWithRequiredIdempotencyHeaders,
} from "./helpers";

/** Internal only. Earn publication and provider surfacing remain separately gated. */
export function registerEarnOnboardingPaths(registry: OpenAPIRegistry) {
  const status = z.object({
    counterpartyId: z.string(),
    state: z.enum(EARN_ONBOARDING_STATES),
    reconciliationRequired: z.boolean().optional(),
    providerStatus: z.string().optional(),
    organizationGuid: z.uuid().nullable().optional(),
    personGuid: z.uuid().nullable().optional(),
    corrections: z.array(z.record(z.string(), z.unknown())).optional(),
    correctionDueAt: z.string().nullable().optional(),
  });
  const security: Array<Record<string, string[]>> = [{ apiKeyAuth: [] }, { clerkBearerAuth: [] }];
  type Params =
    | typeof onboardingParamsSchema
    | typeof onboardingFormParamsSchema
    | typeof onboardingCorrectionParamsSchema;
  function route(
    method: "get" | "post",
    path: string,
    operationId: string,
    summary: string,
    params: Params,
    response: z.ZodType,
    body?: z.ZodType
  ) {
    const request: NonNullable<Parameters<OpenAPIRegistry["registerPath"]>[0]["request"]> = {
      params,
      headers: method === "get" ? projectScopeHeaders : projectScopeWithRequiredIdempotencyHeaders,
    };
    if (body !== undefined) request.body = { required: true, content: jsonContent(body) };
    const code = path.endsWith("/documents") ? 201 : 200;
    const responses: NonNullable<Parameters<OpenAPIRegistry["registerPath"]>[0]["responses"]> = {
      200: {
        description: "Onboarding result",
        content: jsonContent(successResponseSchema(response)),
      },
      ...errorResponses(errorResponseSchema, [400, 401, 403, 404, 409, 413, 429, 500, 503]),
    };
    // Document storage creates a reference; every other route returns 200.
    if (code === 201) {
      responses[201] = {
        description: "Document stored",
        content: jsonContent(successResponseSchema(response)),
      };
    }
    registry.registerPath({
      method,
      path: `/v1/earn/onboarding/wisdomtree/${path}`,
      operationId,
      summary,
      tags: ["Earn"],
      security,
      description:
        "Authenticated project-scoped Moderator onboarding for an existing SDP counterparty. " +
        "Requires earn.read for reads and earn.execute plus Idempotency-Key for writes. " +
        "Use current form rules and the applicant's own agreement answers. No applicant data is persisted by SDP. " +
        "A submitted application is not approval. A timeout requires reconciliation before another create. " +
        "Child organization and person GUIDs are derived from the durable mapping; callers cannot select them.",
      request,
      responses,
    });
  }
  route(
    "get",
    "forms/{entityType}",
    "getEarnWisdomTreeOnboardingForm",
    "Get the current WisdomTree KYC or KYB form",
    onboardingFormParamsSchema,
    z.object({ form: z.record(z.string(), z.unknown()) })
  );
  route(
    "get",
    "{counterpartyId}",
    "getEarnWisdomTreeOnboarding",
    "Get customer verification status and corrections",
    onboardingParamsSchema,
    status
  );
  route(
    "post",
    "{counterpartyId}",
    "saveEarnWisdomTreeOnboarding",
    "Create KYC or save/submit the same KYB application",
    onboardingParamsSchema,
    status,
    onboardingApplicationSchema
  );
  route(
    "post",
    "{counterpartyId}/documents",
    "uploadEarnWisdomTreeOnboardingDocument",
    "Upload one PDF, JPEG or PNG (base64, up to 20 MiB decoded)",
    onboardingParamsSchema,
    z.object({ documentId: z.string() }),
    onboardingUploadSchema
  );
  route(
    "post",
    "{counterpartyId}/corrections/{reasonId}",
    "answerEarnWisdomTreeOnboardingCorrection",
    "Answer one KYB correction; submit the same application afterward",
    onboardingCorrectionParamsSchema,
    z.object({ counterpartyId: z.string(), reasonId: z.number(), answered: z.boolean() }),
    onboardingCorrectionBodySchema
  );
  route(
    "post",
    "{counterpartyId}/wallets",
    "registerEarnWisdomTreeCustomerWallet",
    "Register a Solana wallet for an active assigned child organization; `signature` is the wallet's base58 Ed25519 signature over the scope-bound registration message proving control of `owner`",
    onboardingParamsSchema,
    z.object({ counterpartyId: z.string(), owner: z.string(), registered: z.boolean() }),
    onboardingWalletSchema
  );
}
