import { SdpEarnError } from "@sdp/earn/errors";
import type { WisdomTreeOnboardingClient } from "@sdp/earn/providers/wisdomtree/onboarding";
import {
  type WisdomTreeBusinessSubmission,
  type WisdomTreeCorrection,
  wisdomTreeBusinessFieldsSchema,
  wisdomTreeBusinessSubmissionSchema,
  wisdomTreeOnboardingRecoverySchema,
  wisdomTreeUploadedDocumentSchema,
} from "@sdp/earn/providers/wisdomtree/onboarding-schemas";
import type { EarnRuntimeContext } from "@sdp/earn/types";
import type { CounterpartyEntityType } from "@sdp/types/counterparties";
import type {
  EarnOnboardingCustomer,
  EarnOnboardingRepository,
  EarnOnboardingScope,
} from "@/db/repositories/earn-onboarding.repository";
import { AppError, badRequest, conflict, internalError, notFound } from "@/lib/errors";
import type { OnboardingApplication } from "@/routes/earn-onboarding/schemas";
import type { CustodyCipher } from "@/services/custody-cipher/cipher-router";

type Provider = Pick<
  WisdomTreeOnboardingClient,
  | "getModerator"
  | "getBusinessForm"
  | "getPersonForm"
  | "saveBusiness"
  | "submitPerson"
  | "getBusiness"
  | "getPerson"
  | "uploadDocument"
  | "answerCorrection"
  | "registerSolanaWallet"
>;

/**
 * WisdomTree processed and refused the registration (any 4xx), or the write
 * could never start (unconfigured credentials, thrown before any HTTP call):
 * nothing was written, so the unverified claim can be released. Timeouts, 5xx
 * and malformed responses leave the outcome unknown — the wallet may be
 * registered — so those claims stay for reconciliation instead.
 */
function isConfirmedWalletRejection(error: unknown): boolean {
  return (
    error instanceof SdpEarnError &&
    (error.code === "BAD_REQUEST" ||
      error.code === "CONFLICT" ||
      error.code === "RATE_LIMITED" ||
      error.code === "PROVIDER_NOT_CONFIGURED")
  );
}

/** No PII is persisted. Only immutable identity links and encrypted upload references. */
export class WisdomTreeOnboardingService {
  constructor(
    private readonly repository: EarnOnboardingRepository,
    private readonly provider: Provider,
    private readonly cipher: CustodyCipher,
    private readonly runtime: EarnRuntimeContext
  ) {}

  async form(entityType: CounterpartyEntityType) {
    await this.provider.getModerator(this.runtime);
    return entityType === "business"
      ? this.provider.getBusinessForm(this.runtime)
      : this.provider.getPersonForm(this.runtime);
  }

  private async customer(scope: EarnOnboardingScope) {
    const row = await this.repository.get(scope);
    if (row === null) throw notFound("Earn onboarding customer");
    const moderator = await this.provider.getModerator(this.runtime);
    if (moderator.guid !== row.moderator_guid)
      throw conflict("WisdomTree moderator credentials changed; reconcile the customer mapping");
    if (row.status === "archived") throw conflict("Earn onboarding customer is archived");
    return { row, moderator };
  }

  private async link(
    scope: EarnOnboardingScope,
    row: EarnOnboardingCustomer,
    reference: { organization_guid?: string; person_guid?: string }
  ) {
    const linked = await this.repository.link(scope, {
      moderatorGuid: row.moderator_guid,
      organizationGuid: reference.organization_guid ?? null,
      personGuid: reference.person_guid ?? null,
    });
    if (linked === null)
      throw internalError("Onboarding identity could not be recorded; reconcile before retrying");
    return linked;
  }

  async save(
    scope: EarnOnboardingScope,
    entityType: CounterpartyEntityType,
    request: OnboardingApplication
  ) {
    const expected = entityType === "business" ? "organization" : "retail";
    if (request.application.entity_type !== expected)
      throw badRequest("Application type does not match the counterparty");
    const moderator = await this.provider.getModerator(this.runtime);
    const existing = await this.repository.get(scope);
    if (existing !== null) {
      if (
        existing.entity_type !== entityType ||
        existing.moderator_guid !== moderator.guid ||
        existing.status !== "linked"
      ) {
        throw conflict(
          "Onboarding already claimed; reconcile the existing application before retrying"
        );
      }
      if (request.application.entity_type === "retail") return this.status(scope);
    }
    const documents = await this.documents(scope, entityType, request.documents);
    const form =
      entityType === "business"
        ? await this.provider.getBusinessForm(this.runtime)
        : await this.provider.getPersonForm(this.runtime);
    if (!form.can_create && existing === null)
      throw new AppError("FORBIDDEN", "WisdomTree does not permit onboarding for this account");
    const claimed =
      existing === null
        ? await this.repository.claim(scope, { entityType, moderatorGuid: moderator.guid })
        : existing;
    if (claimed === null)
      throw conflict("Another request already claimed this onboarding customer");
    try {
      if (request.application.entity_type === "organization") {
        const application: WisdomTreeBusinessSubmission = { ...request.application, ...documents };
        if (claimed.organization_guid !== null) application.org_guid = claimed.organization_guid;
        const result = await this.provider.saveBusiness(
          this.runtime,
          wisdomTreeBusinessSubmissionSchema.parse(application)
        );
        if (existing === null) await this.link(scope, claimed, result);
        else if (result.organization_guid !== existing.organization_guid)
          throw internalError("WisdomTree changed an existing customer identity");
      } else {
        const result = await this.provider.submitPerson(this.runtime, request.application);
        await this.link(scope, claimed, result);
      }
    } catch (error) {
      if (existing === null) await this.recoverCreate(scope, claimed, error);
      throw error;
    }
    // Do not cache the provider's response, which can echo the applicant.
    return { counterpartyId: scope.counterpartyId, state: "linked" as const };
  }

  private async documents(
    scope: EarnOnboardingScope,
    entityType: CounterpartyEntityType,
    references: OnboardingApplication["documents"]
  ) {
    const documents: Record<string, { blob_path: string; original_filename?: string }> = {};
    if (references === undefined) return documents;
    if (entityType !== "business")
      throw badRequest("Individual onboarding does not accept business documents");
    for (const [key, id] of Object.entries(references)) {
      if (key in wisdomTreeBusinessFieldsSchema.shape)
        throw badRequest("Document slot overlaps an application field");
      documents[key] = await this.document(scope, id);
    }
    return documents;
  }

  private async recoverCreate(
    scope: EarnOnboardingScope,
    claimed: EarnOnboardingCustomer,
    cause: unknown
  ) {
    if (!(cause instanceof SdpEarnError)) return;
    const recovery = wisdomTreeOnboardingRecoverySchema.safeParse(cause.details);
    if (!recovery.success) return;
    const reference = recovery.data;
    if (claimed.entity_type === "business" && reference.organization_guid !== undefined) {
      await this.link(scope, claimed, { organization_guid: reference.organization_guid });
    }
    if (claimed.entity_type === "individual" && reference.person_guid !== undefined) {
      await this.link(scope, claimed, { person_guid: reference.person_guid });
    }
  }

  async status(scope: EarnOnboardingScope) {
    const { row } = await this.customer(scope);
    if (row.status === "claimed")
      return {
        counterpartyId: scope.counterpartyId,
        state: row.status,
        reconciliationRequired: true,
      };
    const guid = row.entity_type === "business" ? row.organization_guid : row.person_guid;
    if (guid === null) throw internalError("Linked onboarding customer has no provider identity");
    const detail =
      row.entity_type === "business"
        ? await this.provider.getBusiness(this.runtime, guid)
        : await this.provider.getPerson(this.runtime, guid);
    if (row.entity_type === "business" && detail.org_guid !== guid)
      throw internalError("WisdomTree returned another customer");
    if (row.entity_type === "individual" && detail.person_guid !== guid)
      throw internalError("WisdomTree returned another customer");
    // Detailed API statuses are open strings. A new status is never approval.
    return {
      counterpartyId: scope.counterpartyId,
      state: row.status,
      providerStatus: detail.onboarding_status,
      organizationGuid: row.organization_guid,
      personGuid: row.person_guid,
      // Retail individuals belong to the moderator, not a new child org. Never
      // promote their organization_guid into a customer-child mapping.
      corrections:
        row.entity_type === "business" && "resubmission_reasons" in detail
          ? detail.resubmission_reasons
          : undefined,
      correctionDueAt:
        row.entity_type === "business" && "correction_due_at" in detail
          ? detail.correction_due_at
          : undefined,
    };
  }

  async registerWallet(scope: EarnOnboardingScope, owner: string) {
    const { row, moderator } = await this.customer(scope);
    if (row.status !== "linked" || row.organization_guid === null)
      throw conflict("A linked business customer is required");
    if (!moderator.client_organizations.some((child) => child.guid === row.organization_guid)) {
      throw conflict("WisdomTree customer is not assigned to the configured moderator");
    }
    const detail = await this.provider.getBusiness(this.runtime, row.organization_guid);
    if (detail.org_guid !== row.organization_guid || detail.onboarding_status !== "active")
      throw conflict("WisdomTree customer verification is not active");
    if (!(await this.repository.claimWallet(scope, owner)))
      throw conflict("Wallet onboarding already claimed; reconcile before retrying");
    try {
      await this.provider.registerSolanaWallet(this.runtime, row.organization_guid, owner);
    } catch (error) {
      // The address is globally unique per environment across every customer.
      // A confirmed rejection releases the unverified claim so it cannot block
      // the real owner; an uncertain outcome (timeout, 5xx, malformed reply)
      // keeps the claim — the provider may have accepted the wallet.
      if (isConfirmedWalletRejection(error)) await this.repository.releaseWallet(scope, owner);
      throw error;
    }
    if (!(await this.repository.linkWallet(scope, owner)))
      throw internalError("Wallet registration could not be recorded; reconcile before retrying");
    return { counterpartyId: scope.counterpartyId, owner, registered: true };
  }

  async upload(scope: EarnOnboardingScope, document: { documentType: string; file: File }) {
    const moderator = await this.provider.getModerator(this.runtime);
    const existing = await this.repository.get(scope);
    if (
      existing !== null &&
      (existing.moderator_guid !== moderator.guid || existing.status === "archived")
    )
      throw conflict("Onboarding customer cannot accept documents");
    const reference = await this.provider.uploadDocument(this.runtime, document);
    const encrypted = await this.cipher.encrypt(this.documentAad(scope), JSON.stringify(reference));
    return { documentId: await this.repository.saveDocument(scope, encrypted) };
  }

  private documentAad(scope: EarnOnboardingScope) {
    return JSON.stringify([
      "earn-onboarding",
      scope.organizationId,
      scope.projectId,
      scope.environment,
      scope.counterpartyId,
    ]);
  }

  private async document(scope: EarnOnboardingScope, id: string) {
    const encrypted = await this.repository.getDocument(scope, id);
    if (encrypted === null) throw notFound("Onboarding document");
    const raw = await this.cipher.decrypt(this.documentAad(scope), encrypted);
    const parsed = wisdomTreeUploadedDocumentSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw internalError("Onboarding document reference is invalid");
    return parsed.data;
  }

  async correct(
    scope: EarnOnboardingScope,
    reasonId: number,
    answer: Omit<WisdomTreeCorrection, "document"> & { documentId?: string }
  ) {
    const { row } = await this.customer(scope);
    if (row.status !== "linked" || row.organization_guid === null)
      throw conflict("A linked business application is required");
    const { documentId, ...body } = answer;
    const correction: WisdomTreeCorrection = body;
    if (documentId !== undefined)
      correction.document = (await this.document(scope, documentId)).blob_path;
    await this.provider.answerCorrection(this.runtime, row.organization_guid, reasonId, correction);
    return { counterpartyId: scope.counterpartyId, reasonId, answered: true };
  }
}
