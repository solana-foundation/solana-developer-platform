/** Signed provider ingress, described internally without public API promotion. */
import type { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";
import { RAMP_PROVIDERS } from "@sdp/types/provider-access";
import { z } from "zod";
import { errorResponseSchema, successResponseSchema } from "@/openapi/schemas/base";
import { MAX_WEBHOOK_BODY_BYTES } from "@/routes/webhooks/schemas";
import { RAMP_PROVIDER_WEBHOOK_PROCESSOR } from "@/services/ramps/webhooks/registry";
import { errorResponses, jsonContent } from "./helpers";

const signedBody = z.string().min(1).max(MAX_WEBHOOK_BODY_BYTES).openapi({
  format: "binary",
  description:
    "Original signed request bytes, at most 1 MiB. Do not parse, normalize, or re-serialize the JSON.",
});
const header = (name: string) =>
  z
    .string()
    .min(1)
    .openapi({ param: { name, in: "header" } });
const errors = errorResponses(errorResponseSchema, [400, 401, 403, 413, 429, 500, 503]);
export function registerWebhookPaths(registry: OpenAPIRegistry) {
  const clerkHeaders = ["svix-id", "svix-timestamp", "svix-signature"] as const;
  for (const name of clerkHeaders)
    registry.registerComponent("securitySchemes", name, { type: "apiKey", in: "header", name });
  registry.registerPath({
    method: "post",
    path: "/webhooks/clerk",
    tags: ["Webhook Ingress"],
    operationId: "receiveClerkWebhook",
    summary: "Deliver a signed Clerk webhook",
    description:
      "Forwards an original Clerk delivery with svix-id, svix-timestamp, and svix-signature. Provider signatures authenticate ingress; SDP API keys, Clerk session tokens, tenant selectors, and idempotency keys are not sent. The server verifies the signature before synchronizing supported organization/user events and mirroring deletions. Acknowledgement does not mean an ignored event changed any state. The CLI makes one request, never signs or rewrites a delivery, and never retries automatically. Maximum body size is 1 MiB; the provider's signed timestamp must still be accepted by the verifier.",
    security: [Object.fromEntries(clerkHeaders.map((name) => [name, []]))],
    request: {
      headers: z.object(Object.fromEntries(clerkHeaders.map((name) => [name, header(name)]))),
      body: { required: true, content: jsonContent(signedBody) },
    },
    responses: {
      200: {
        description: "Verified Clerk delivery acknowledged",
        content: jsonContent(successResponseSchema(z.strictObject({ received: z.literal(true) }))),
      },
      ...errors,
    },
  });
  const signatures = Object.entries(RAMP_PROVIDER_WEBHOOK_PROCESSOR).map(
    ([provider, processor]) => ({
      provider,
      header: processor.signature.header,
      scheme: `${provider}WebhookSignature`,
    })
  );
  for (const signature of signatures)
    registry.registerComponent("securitySchemes", signature.scheme, {
      type: "apiKey",
      in: "header",
      name: signature.header,
    });
  for (const environment of ["sandbox", "production"] as const) {
    registry.registerPath({
      method: "post",
      path: `/webhooks/payments/ramps/${environment}/{provider}`,
      tags: ["Webhook Ingress"],
      operationId:
        environment === "sandbox" ? "receiveSandboxRampWebhook" : "receiveProductionRampWebhook",
      summary: `Deliver a signed ${environment} ramp webhook`,
      description: `Forwards the original signed provider body to the explicit ${environment} ingress. Stripe uses stripe-signature (t=...,v1=...); MoonPay uses moonpay-signature-v2 (t=...,s=...). Supply the header for the selected provider; the server verifies it with that environment's managed secret and signed timestamp. SDP account credentials, tenant selectors, and idempotency keys are not sent. The API enforces the ramps release channel and provider gate. A 200 acknowledges a verified delivery durably stored in the event inbox; application and settlement happen in the background and may be ignored, unmatched, or fail. Receipt never proves transfer completion. The CLI makes one request without signing, rewriting, retrying, polling, or replaying events. Maximum body size is 1 MiB.`,
      security: signatures.map(({ scheme }) => ({ [scheme]: [] })),
      request: {
        params: z.object({ provider: z.enum(RAMP_PROVIDERS) }),
        headers: z.object(
          Object.fromEntries(
            signatures.map((signature) => [signature.header, header(signature.header).optional()])
          )
        ),
        body: { required: true, content: jsonContent(signedBody) },
      },
      responses: {
        200: {
          description: "Verified delivery durably received; settlement is asynchronous",
          content: jsonContent(
            successResponseSchema(
              z.strictObject({
                received: z.literal(true),
                provider: z.enum(RAMP_PROVIDERS),
                environment: z.literal(environment),
              })
            )
          ),
        },
        ...errors,
      },
    });
  }
}
