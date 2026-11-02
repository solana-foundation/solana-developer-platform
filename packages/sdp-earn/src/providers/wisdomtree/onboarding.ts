import { z } from "zod";
import { badRequest, providerUnavailable } from "#/errors";
import type { EarnRuntimeContext } from "#/types";
import { requestWisdomTreeOnboarding } from "./connect";
import {
  type WisdomTreeBusinessPatch,
  type WisdomTreeBusinessSubmission,
  type WisdomTreeCorrection,
  type WisdomTreePersonSubmission,
  wisdomTreeBusinessDetailSchema,
  wisdomTreeBusinessPatchSchema,
  wisdomTreeBusinessResultSchema,
  wisdomTreeBusinessSubmissionSchema,
  wisdomTreeCorrectionResultSchema,
  wisdomTreeCorrectionSchema,
  wisdomTreeGuidSchema,
  wisdomTreeModeratorSchema,
  wisdomTreeOnboardingFormSchema,
  wisdomTreeOnboardingRecordsSchema,
  wisdomTreePersonDetailSchema,
  wisdomTreePersonResultSchema,
  wisdomTreePersonSubmissionSchema,
  wisdomTreeUploadedDocumentSchema,
} from "./onboarding-schemas";

export const WISDOMTREE_ONBOARDING_MAX_REQUEST_BYTES = 25 * 1024 * 1024;
const documentInputSchema = z.object({
  documentType: z.string().min(1).max(256),
  file: z
    .file()
    .min(1)
    .max(WISDOMTREE_ONBOARDING_MAX_REQUEST_BYTES)
    .mime(["application/pdf", "image/jpeg", "image/png"]),
});
const jsonObject = z.record(z.string(), z.json());

function input<S extends z.ZodType>(schema: S, value: z.input<S>): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw badRequest("Invalid WisdomTree onboarding input");
  return result.data;
}

/**
 * KYC/KYB HTTP operations. No database, polling loop, signing or automatic
 * write retries. The API owns tenant mappings and durable create claims.
 * Forms and applicant answers are always live; no agreement is auto-accepted.
 */
export class WisdomTreeOnboardingClient {
  async getBusinessForm(ctx: EarnRuntimeContext) {
    return requestWisdomTreeOnboarding(ctx, {
      method: "GET",
      path: "/api/onboarding/org",
      responseSchema: wisdomTreeOnboardingFormSchema,
    });
  }

  async getPersonForm(ctx: EarnRuntimeContext) {
    return requestWisdomTreeOnboarding(ctx, {
      method: "GET",
      path: "/api/onboarding/person",
      responseSchema: wisdomTreeOnboardingFormSchema,
    });
  }

  async listRecords(ctx: EarnRuntimeContext) {
    return requestWisdomTreeOnboarding(ctx, {
      method: "GET",
      path: "/api/onboarding/",
      responseSchema: wisdomTreeOnboardingRecordsSchema,
    });
  }

  async saveBusiness(ctx: EarnRuntimeContext, submission: WisdomTreeBusinessSubmission) {
    const body = input(wisdomTreeBusinessSubmissionSchema, submission);
    if (Buffer.byteLength(JSON.stringify(body)) > WISDOMTREE_ONBOARDING_MAX_REQUEST_BYTES) {
      throw badRequest("WisdomTree onboarding request exceeds 25 MB");
    }
    return requestWisdomTreeOnboarding(ctx, {
      method: "POST",
      path: "/api/onboarding/",
      body,
      responseSchema: wisdomTreeBusinessResultSchema,
    });
  }

  async submitPerson(ctx: EarnRuntimeContext, submission: WisdomTreePersonSubmission) {
    return requestWisdomTreeOnboarding(ctx, {
      method: "POST",
      path: "/api/onboarding/",
      body: input(wisdomTreePersonSubmissionSchema, submission),
      responseSchema: wisdomTreePersonResultSchema,
    });
  }

  async getBusiness(ctx: EarnRuntimeContext, guid: string) {
    return requestWisdomTreeOnboarding(ctx, {
      method: "GET",
      path: `/api/onboarding/${input(wisdomTreeGuidSchema, guid)}/org`,
      responseSchema: wisdomTreeBusinessDetailSchema,
    });
  }

  async getPerson(ctx: EarnRuntimeContext, guid: string) {
    return requestWisdomTreeOnboarding(ctx, {
      method: "GET",
      path: `/api/onboarding/${input(wisdomTreeGuidSchema, guid)}/person`,
      responseSchema: wisdomTreePersonDetailSchema,
    });
  }

  async updateBusiness(ctx: EarnRuntimeContext, guid: string, patch: WisdomTreeBusinessPatch) {
    return requestWisdomTreeOnboarding(ctx, {
      method: "PATCH",
      path: `/api/onboarding/${input(wisdomTreeGuidSchema, guid)}/org`,
      body: input(wisdomTreeBusinessPatchSchema, patch),
      responseSchema: jsonObject,
    });
  }

  async answerCorrection(
    ctx: EarnRuntimeContext,
    guid: string,
    reasonId: number,
    answer: WisdomTreeCorrection
  ) {
    return requestWisdomTreeOnboarding(ctx, {
      method: "POST",
      path: `/api/onboarding/${input(wisdomTreeGuidSchema, guid)}/corrections/${input(z.number().int().positive(), reasonId)}/`,
      body: input(wisdomTreeCorrectionSchema, answer),
      responseSchema: wisdomTreeCorrectionResultSchema,
    });
  }

  async uploadDocument(ctx: EarnRuntimeContext, document: z.infer<typeof documentInputSchema>) {
    const { documentType, file } = input(documentInputSchema, document);
    const form = new FormData();
    form.set("document_type", documentType);
    form.set("file", file);
    // Check the WHOLE multipart request, including headers and boundary. A
    // 25 MB file alone would exceed Connect's 25 MB request ceiling.
    const encoded = new Request("https://onboarding.invalid", { method: "POST", body: form });
    const bytes = await encoded.arrayBuffer();
    if (bytes.byteLength > WISDOMTREE_ONBOARDING_MAX_REQUEST_BYTES) {
      throw badRequest("WisdomTree document request exceeds 25 MB including multipart overhead");
    }
    return requestWisdomTreeOnboarding(ctx, {
      method: "POST",
      path: "/api/onboarding/upload/",
      body: form,
      responseSchema: wisdomTreeUploadedDocumentSchema,
    });
  }

  /** Verify the moderator identity and the LIVE set of assigned children. */
  async getModerator(ctx: EarnRuntimeContext) {
    const result = await requestWisdomTreeOnboarding(ctx, {
      method: "GET",
      path: "/api/organizations/me",
      responseSchema: wisdomTreeModeratorSchema,
    });
    return result;
  }

  async registerSolanaWallet(ctx: EarnRuntimeContext, childGuid: string, owner: string) {
    return requestWisdomTreeOnboarding(ctx, {
      method: "POST",
      path: `/api/organizations/${input(wisdomTreeGuidSchema, childGuid)}/wallets`,
      body: { public_key: owner, blockchain: "Solana", organization_guid: childGuid },
      responseSchema: jsonObject,
    });
  }

  async assertChildOrganization(ctx: EarnRuntimeContext, moderatorGuid: string, childGuid: string) {
    const moderator = await this.getModerator(ctx);
    if (
      moderator.guid !== moderatorGuid ||
      moderator.guid === childGuid ||
      !moderator.client_organizations.some((child) => child.guid === childGuid)
    ) {
      throw providerUnavailable("WisdomTree customer is not assigned to the configured moderator");
    }
  }
}
