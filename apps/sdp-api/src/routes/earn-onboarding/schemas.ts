import {
  wisdomTreeBusinessFieldsSchema,
  wisdomTreeCorrectionFieldsSchema,
  wisdomTreePersonSubmissionSchema,
} from "@sdp/earn/providers/wisdomtree/onboarding-schemas";
import { COUNTERPARTY_ENTITY_TYPES } from "@sdp/types/counterparties";
import { isAddress } from "@solana/addresses";
import { z } from "zod";

export const onboardingParamsSchema = z.object({ counterpartyId: z.string().min(1) });
export const onboardingFormParamsSchema = z.object({
  entityType: z.enum(COUNTERPARTY_ENTITY_TYPES),
});
export const onboardingCorrectionParamsSchema = onboardingParamsSchema.extend({
  reasonId: z.coerce.number().int().positive(),
});
// Identity and parent GUIDs are ALWAYS derived from the authenticated mapping.
// Document slots use customer-scoped SDP IDs, never caller-supplied blob paths.
export const onboardingApplicationSchema = z
  .object({
    application: z.discriminatedUnion("entity_type", [
      wisdomTreePersonSubmissionSchema,
      wisdomTreeBusinessFieldsSchema.omit({ org_guid: true, parent_org_guid: true }).strict(),
    ]),
    documents: z.record(z.string().min(1), z.string().startsWith("earn_document_")).optional(),
  })
  .strict();

export const EARN_ONBOARDING_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const EARN_ONBOARDING_MAX_BODY_BYTES = 28 * 1024 * 1024;
export const onboardingUploadSchema = z
  .object({
    documentType: z.string().min(1).max(256),
    filename: z.string().min(1).max(256),
    contentType: z.enum(["application/pdf", "image/jpeg", "image/png"]),
    contentBase64: z
      .string()
      .min(4)
      .max(4 * Math.ceil(EARN_ONBOARDING_MAX_FILE_BYTES / 3))
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  })
  .strict();
export const onboardingCorrectionBodySchema = wisdomTreeCorrectionFieldsSchema
  .omit({ document: true })
  .extend({
    documentId: z.string().startsWith("earn_document_").optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);
export type OnboardingApplication = z.infer<typeof onboardingApplicationSchema>;

export const onboardingWalletSchema = z
  .object({ owner: z.string().refine(isAddress, "Invalid Solana address") })
  .strict();
