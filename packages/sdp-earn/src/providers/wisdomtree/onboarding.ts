import type { CounterpartyEntityType } from "@sdp/types/counterparties";
import { z } from "zod";
import { badRequest, providerUnavailable, type SdpEarnError } from "#/errors";
import type {
  EarnOnboardingApplicationResult,
  EarnOnboardingCorrectionAnswer,
  EarnOnboardingCustomerDetail,
  EarnOnboardingDocumentReference,
  EarnOnboardingForm,
  EarnOnboardingModerator,
  EarnOnboardingRegistrationScope,
  EarnRuntimeContext,
} from "#/types";
import { requestWisdomTreeOnboarding } from "./connect";
import {
  type WisdomTreeBusinessPatch,
  type WisdomTreeBusinessSubmission,
  type WisdomTreeCorrection,
  type WisdomTreePersonSubmission,
  wisdomTreeBusinessDetailSchema,
  wisdomTreeBusinessFieldsSchema,
  wisdomTreeBusinessPatchSchema,
  wisdomTreeBusinessResultSchema,
  wisdomTreeBusinessSubmissionSchema,
  wisdomTreeCorrectionResultSchema,
  wisdomTreeCorrectionSchema,
  wisdomTreeGuidSchema,
  wisdomTreeModeratorSchema,
  wisdomTreeOnboardingFormSchema,
  wisdomTreeOnboardingRecordsSchema,
  wisdomTreeOnboardingRecoverySchema,
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
 * The exact bytes a wallet must sign to prove control of itself for this
 * registration. The message binds every scope dimension (organization,
 * project, environment, counterparty) plus the address, so one signature can
 * never be replayed for another customer, project or wallet, and no challenge
 * round trip is needed. Clients sign the UTF-8 text with the wallet's Ed25519
 * key and send the base58 signature.
 */
export function wisdomTreeWalletRegistrationMessage(
  scope: EarnOnboardingRegistrationScope,
  owner: string
): Uint8Array {
  return new TextEncoder().encode(
    [
      "WisdomTree wallet registration",
      `organization: ${scope.organizationId}`,
      `project: ${scope.projectId}`,
      `environment: ${scope.environment}`,
      `counterparty: ${scope.counterpartyId}`,
      `owner: ${owner}`,
    ].join("\n")
  );
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

  // ── EarnOnboardingProvider surface ────────────────────────────────────────
  // The shared API orchestration calls only these: the provider's wire
  // vocabulary (submissions, corrections, document slots, GUID names) stops
  // here. Each neutral method dispatches through `this.<wire method>`, so a
  // test spy on the wire method still observes every orchestration call.

  async getOnboardingModerator(ctx: EarnRuntimeContext): Promise<EarnOnboardingModerator> {
    const moderator = await this.getModerator(ctx);
    return { guid: moderator.guid, clientOrganizations: moderator.client_organizations };
  }

  async getOnboardingForm(
    ctx: EarnRuntimeContext,
    entityType: CounterpartyEntityType
  ): Promise<EarnOnboardingForm> {
    const form =
      entityType === "business" ? await this.getBusinessForm(ctx) : await this.getPersonForm(ctx);
    return { canCreate: form.can_create, form };
  }

  onboardingApplicationFields(entityType: CounterpartyEntityType): ReadonlySet<string> {
    // Business submissions are open-ended except for these fields, so a
    // document slot colliding with one must be refused before anything is
    // claimed. Individual onboarding takes no documents at all.
    return entityType === "business"
      ? new Set(Object.keys(wisdomTreeBusinessFieldsSchema.shape))
      : new Set();
  }

  async saveOnboardingApplication(
    ctx: EarnRuntimeContext,
    submission: {
      entityType: CounterpartyEntityType;
      application: Record<string, unknown>;
      documents?: Record<string, EarnOnboardingDocumentReference>;
      linkedOrganizationGuid?: string | null;
    }
  ): Promise<EarnOnboardingApplicationResult> {
    if (submission.entityType === "business") {
      const application: Record<string, unknown> = { ...submission.application };
      for (const [slot, document] of Object.entries(submission.documents ?? {})) {
        // An upload may come back without a filename. Keep the key absent
        // rather than undefined: the business catchall validates slots as
        // JSON, and an explicit undefined value would fail the parse after
        // the customer was claimed, forcing operator recovery.
        const upload: Record<string, unknown> = { blob_path: document.blobPath };
        if (document.originalFilename !== undefined) {
          upload.original_filename = document.originalFilename;
        }
        application[slot] = upload;
      }
      if (
        submission.linkedOrganizationGuid !== null &&
        submission.linkedOrganizationGuid !== undefined
      ) {
        application.org_guid = submission.linkedOrganizationGuid;
      }
      const result = await this.saveBusiness(
        ctx,
        wisdomTreeBusinessSubmissionSchema.parse(application)
      );
      return { organizationGuid: result.organization_guid };
    }
    const result = await this.submitPerson(
      ctx,
      wisdomTreePersonSubmissionSchema.parse(submission.application)
    );
    return { personGuid: result.person_guid };
  }

  async getOnboardingCustomerDetail(
    ctx: EarnRuntimeContext,
    input: { entityType: CounterpartyEntityType; reference: string }
  ): Promise<EarnOnboardingCustomerDetail> {
    if (input.entityType === "business") {
      const detail = await this.getBusiness(ctx, input.reference);
      return {
        reference: detail.org_guid,
        providerStatus: detail.onboarding_status,
        corrections: detail.resubmission_reasons,
        correctionDueAt: detail.correction_due_at,
      };
    }
    const detail = await this.getPerson(ctx, input.reference);
    return { reference: detail.person_guid, providerStatus: detail.onboarding_status };
  }

  async uploadOnboardingDocument(
    ctx: EarnRuntimeContext,
    document: { documentType: string; file: File }
  ): Promise<EarnOnboardingDocumentReference> {
    const uploaded = await this.uploadDocument(ctx, document);
    return { blobPath: uploaded.blob_path, originalFilename: uploaded.original_filename };
  }

  async answerOnboardingCorrection(
    ctx: EarnRuntimeContext,
    input: { reference: string; reasonId: number; answer: EarnOnboardingCorrectionAnswer }
  ): Promise<void> {
    await this.answerCorrection(
      ctx,
      input.reference,
      input.reasonId,
      wisdomTreeCorrectionSchema.parse(input.answer)
    );
  }

  async registerOnboardingWallet(
    ctx: EarnRuntimeContext,
    input: { reference: string; owner: string }
  ): Promise<void> {
    await this.registerSolanaWallet(ctx, input.reference, input.owner);
  }

  walletRegistrationMessage(scope: EarnOnboardingRegistrationScope, owner: string): Uint8Array {
    return wisdomTreeWalletRegistrationMessage(scope, owner);
  }

  onboardingRecoveryReferences(error: SdpEarnError): EarnOnboardingApplicationResult {
    const recovery = wisdomTreeOnboardingRecoverySchema.safeParse(error.details);
    if (!recovery.success) return {};
    return {
      organizationGuid: recovery.data.organization_guid,
      personGuid: recovery.data.person_guid,
    };
  }
}

/** The one onboarding adapter instance, composed into WisdomTree's registry client. */
export const wisdomTreeOnboardingClient = new WisdomTreeOnboardingClient();
