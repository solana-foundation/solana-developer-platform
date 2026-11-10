import { WISDOM_TREE_BUSINESS_APPLICATION_STATUSES } from "@sdp/types/earn-onboarding";
import { z } from "zod";

// The current form owns conditional CDD fields, choices, document keys and
// agreements. Keep its JSON intact rather than freezing a copy of its rules.
// JSON object is intentionally open; metadata also prevents OpenAPI tooling
// from recursively expanding z.json()'s unbounded union.
const jsonObject = z
  .record(z.string(), z.json())
  .meta({ type: "object", additionalProperties: true });
const nonempty = z.string().min(1);
export const wisdomTreeGuidSchema = z.uuid();

export const wisdomTreeOnboardingFormSchema = z
  .object({
    can_create: z.boolean(),
    submission_template: jsonObject,
    sections: z.array(jsonObject),
  })
  .catchall(z.json());

export const wisdomTreeUploadedDocumentSchema = z
  .object({
    blob_path: nonempty,
    original_filename: nonempty.optional(),
  })
  .catchall(z.json());

export const wisdomTreePersonSubmissionSchema = z
  .object({
    entity_type: z.literal("retail"),
    first_name: nonempty,
    last_name: nonempty,
    email: z.email(),
    phone_number: nonempty,
    date_of_birth: z.string().regex(/^\d{2}-\d{2}-\d{4}$/),
    tax_id: z.string().regex(/^\d{9}$/),
    address: nonempty,
    flat_number: z.string().optional(),
    city: nonempty,
    state: nonempty,
    postal_code: nonempty,
    country: z.literal("US"),
    primary_source_of_funds: nonempty,
    client_external_id: nonempty.optional(),
    agreement_set_version: nonempty,
    agreements: z
      .array(
        z
          .object({
            key: nonempty,
            version: nonempty,
            accepted: z.boolean(),
          })
          .strict()
      )
      .min(1),
  })
  .strict();

export const wisdomTreeBusinessFieldsSchema = z.object({
  entity_type: z.literal("organization"),
  // Explicit intent: omission at Connect submits immediately.
  status: z.enum(WISDOM_TREE_BUSINESS_APPLICATION_STATUSES),
  org_guid: wisdomTreeGuidSchema.optional(),
  parent_org_guid: wisdomTreeGuidSchema.optional(),
  org_details: jsonObject.optional(),
  control_person: jsonObject.optional(),
  owners: jsonObject.optional(),
  authorized_rep: jsonObject.optional(),
  aml_profile: jsonObject.optional(),
  source: jsonObject.optional(),
  sanctions: jsonObject.optional(),
  agreement_details: jsonObject.optional(),
});
const businessSubmission = wisdomTreeBusinessFieldsSchema.catchall(z.json());
export const wisdomTreeBusinessSubmissionSchema = businessSubmission.superRefine((value, ctx) => {
  for (const [key, document] of Object.entries(value)) {
    if (
      !(key in businessSubmission.shape) &&
      document !== null &&
      !wisdomTreeUploadedDocumentSchema.safeParse(document).success
    ) {
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: "Expected an uploaded document object",
      });
    }
  }
});

// A redacted GET is display data, never a submission template. It carries
// masked IDs, blank personal fields and numeric document references.
export const wisdomTreeBusinessDetailSchema = z
  .object({
    org_guid: wisdomTreeGuidSchema,
    onboarding_status: nonempty,
    sensitive_data_redacted: z.boolean(),
    resubmission_reasons: z.array(jsonObject).optional(),
    correction_due_at: z.string().nullable().optional(),
  })
  .catchall(z.json());

export const wisdomTreePersonDetailSchema = z
  .object({
    person_guid: wisdomTreeGuidSchema,
    organization_guid: wisdomTreeGuidSchema,
    onboarding_status: nonempty,
    sensitive_data_redacted: z.boolean(),
  })
  .catchall(z.json());

export const wisdomTreeBusinessResultSchema = z
  .object({
    organization_guid: wisdomTreeGuidSchema,
    status: nonempty.optional(),
  })
  .catchall(z.json());
export const wisdomTreePersonResultSchema = z
  .object({
    person_guid: wisdomTreeGuidSchema,
  })
  .catchall(z.json());

export const wisdomTreeOnboardingRecordsSchema = z
  .object({
    organizations: z.array(
      z
        .object({
          organization_guid: wisdomTreeGuidSchema,
          onboarding_status: nonempty,
        })
        .catchall(z.json())
    ),
    persons: z.array(
      z
        .object({
          person_guid: wisdomTreeGuidSchema,
          onboarding_status: nonempty,
        })
        .catchall(z.json())
    ),
  })
  .catchall(z.json());

export const wisdomTreeBusinessPatchSchema = z
  .object({
    // PATCH never submits or changes identity/parentage.
    status: z.never().optional(),
    entity_type: z.never().optional(),
    org_guid: z.never().optional(),
    parent_org_guid: z.never().optional(),
  })
  .catchall(z.json())
  .refine((value) => Object.keys(value).length > 0);

export const wisdomTreeCorrectionFieldsSchema = z
  .object({
    values: jsonObject.optional(),
    document: nonempty.optional(),
    explanation: nonempty.optional(),
    attested: z.boolean().optional(),
  })
  .strict();
export const wisdomTreeCorrectionSchema = wisdomTreeCorrectionFieldsSchema.refine(
  (value) => Object.keys(value).length > 0
);
export const wisdomTreeCorrectionResultSchema = z
  .object({
    reason: z
      .object({
        id: z.number().int().positive(),
        requiredAction: nonempty,
        partnerResubmitted: z.boolean(),
      })
      .catchall(z.json()),
  })
  .catchall(z.json());

// Error bodies may echo SSNs, CDD answers and documents. Only these typed
// recovery identifiers may escape into errors/logs; never the body or cause.
export const wisdomTreeOnboardingRecoverySchema = z.object({
  organization_guid: wisdomTreeGuidSchema.optional(),
  person_guid: wisdomTreeGuidSchema.optional(),
});

export type WisdomTreeOnboardingForm = z.infer<typeof wisdomTreeOnboardingFormSchema>;
export type WisdomTreePersonSubmission = z.infer<typeof wisdomTreePersonSubmissionSchema>;
export type WisdomTreeBusinessSubmission = z.infer<typeof wisdomTreeBusinessSubmissionSchema>;
export type WisdomTreeBusinessPatch = z.infer<typeof wisdomTreeBusinessPatchSchema>;
export type WisdomTreeCorrection = z.infer<typeof wisdomTreeCorrectionSchema>;
export type WisdomTreeUploadedDocument = z.infer<typeof wisdomTreeUploadedDocumentSchema>;

export const wisdomTreeModeratorSchema = z
  .object({
    guid: wisdomTreeGuidSchema,
    client_organizations: z.array(z.object({ guid: wisdomTreeGuidSchema }).catchall(z.json())),
  })
  .catchall(z.json());
