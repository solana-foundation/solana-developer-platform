import { SdpEarnError } from "@sdp/earn/errors";
import type { EarnOnboardingProvider, EarnRuntimeContext } from "@sdp/earn/types";
import type { CounterpartyEntityType } from "@sdp/types/counterparties";
import {
  address,
  getBase58Encoder,
  getPublicKeyFromAddress,
  isSignatureBytes,
  verifySignature,
} from "@solana/kit";
import { z } from "zod";
import type {
  EarnOnboardingCustomer,
  EarnOnboardingRepository,
  EarnOnboardingScope,
} from "@/db/repositories/earn-onboarding.repository";
import { AppError, badRequest, conflict, internalError, notFound } from "@/lib/errors";
import type { OnboardingApplication } from "@/routes/earn-onboarding/schemas";
import type { CustodyCipher } from "@/services/custody-cipher/cipher-router";
import type { CustodyConfigStore } from "@/services/stores/custody-config.store";

/** The project's custody wallets, whose keys SDP holds and signs with. */
type CustodyWallets = Pick<
  CustodyConfigStore,
  "findActiveWalletByPublicKey" | "findActiveConnectionWalletByPublicKey"
>;

/** The document reference the API stores, encrypted: the provider's own upload answer. */
const storedDocumentReferenceSchema = z.object({
  blobPath: z.string().min(1),
  originalFilename: z.string().min(1).optional(),
});

/**
 * WisdomTree processed and refused the registration (any 4xx), or the write
 * could never start (unconfigured credentials, thrown before any HTTP call):
 * nothing was written, so the unverified claim can be released. Timeouts, 5xx
 * and malformed responses leave the outcome unknown — the wallet may be
 * registered — so those claims stay for reconciliation instead.
 */
function isConfirmedWalletRejection(error: SdpEarnError): boolean {
  return (
    error.code === "BAD_REQUEST" ||
    error.code === "CONFLICT" ||
    error.code === "RATE_LIMITED" ||
    error.code === "PROVIDER_NOT_CONFIGURED"
  );
}

/** Whether `signature` is the wallet's own valid Ed25519 signature over the scope-bound registration message. */
async function provesWalletOwnership(
  provider: EarnOnboardingProvider,
  scope: EarnOnboardingScope,
  owner: string,
  signature: string
): Promise<boolean> {
  try {
    const signatureBytes = getBase58Encoder().encode(signature);
    // An Ed25519 signature is always exactly 64 bytes; anything else cannot verify.
    if (signatureBytes.length !== 64 || !isSignatureBytes(signatureBytes)) return false;
    const publicKey = await getPublicKeyFromAddress(address(owner));
    return await verifySignature(
      publicKey,
      signatureBytes,
      provider.walletRegistrationMessage(scope, owner)
    );
  } catch {
    return false;
  }
}

/**
 * The SHARED onboarding orchestration behind every provider's KYC/KYB routes
 * (dispatched by capability — `supportsOnboarding` — never a provider-id
 * check). SDP owns what must never drift between providers: durable claims,
 * identity links, moderator-consistency checks, encrypted document
 * references, wallet claim/verify/register, and recovery of uncertain
 * submissions. The provider's own forms, application and correction
 * vocabulary and registration proof message live behind `EarnOnboardingProvider`.
 * No PII is persisted. Only immutable identity links and encrypted upload references.
 */
export class EarnOnboardingService {
  constructor(
    private readonly repository: EarnOnboardingRepository,
    private readonly provider: EarnOnboardingProvider,
    private readonly cipher: CustodyCipher,
    private readonly runtime: EarnRuntimeContext,
    private readonly custodyWallets: CustodyWallets
  ) {}

  /**
   * Proof of control before anything is claimed or written. External wallets
   * sign the scope-bound registration message with the wallet's own Ed25519
   * key. An SDP-managed custody wallet has no private key or arbitrary-message
   * signing endpoint to expose, so its authorized project binding — an active
   * wallet, config-owned or connection-owned, under this organization's and
   * project's active custody config or connection — is the alternative proof:
   * the keys are generated and held by SDP, and only a project-authorized
   * caller can reach this registration at all. A binding of any other project
   * or organization proves nothing.
   */
  private async assertControlProven(
    scope: EarnOnboardingScope,
    owner: string,
    signature?: string
  ): Promise<void> {
    if (signature === undefined) {
      const [configBound, connectionBound] = await Promise.all([
        this.custodyWallets.findActiveWalletByPublicKey(
          scope.organizationId,
          scope.projectId,
          owner
        ),
        this.custodyWallets.findActiveConnectionWalletByPublicKey(
          scope.organizationId,
          scope.projectId,
          owner
        ),
      ]);
      if (configBound !== null || connectionBound !== null) return;
      throw badRequest(
        "Provide the wallet's base58 signature over the registration message, or register an SDP custody wallet of this project"
      );
    }
    if (!(await provesWalletOwnership(this.provider, scope, owner, signature)))
      throw badRequest("The wallet signature does not prove control of the address");
  }

  async form(entityType: CounterpartyEntityType) {
    await this.provider.getOnboardingModerator(this.runtime);
    return (await this.provider.getOnboardingForm(this.runtime, entityType)).form;
  }

  private async customer(scope: EarnOnboardingScope) {
    const row = await this.repository.get(scope);
    if (row === null) throw notFound("Earn onboarding customer");
    const moderator = await this.provider.getOnboardingModerator(this.runtime);
    if (moderator.guid !== row.moderator_guid)
      throw conflict("Onboarding provider credentials changed; reconcile the customer mapping");
    if (row.status === "archived") throw conflict("Earn onboarding customer is archived");
    return { row, moderator };
  }

  private async link(
    scope: EarnOnboardingScope,
    row: EarnOnboardingCustomer,
    reference: { organizationGuid?: string; personGuid?: string }
  ) {
    const linked = await this.repository.link(scope, {
      moderatorGuid: row.moderator_guid,
      organizationGuid: reference.organizationGuid ?? null,
      personGuid: reference.personGuid ?? null,
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
    const moderator = await this.provider.getOnboardingModerator(this.runtime);
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
    const form = await this.provider.getOnboardingForm(this.runtime, entityType);
    if (!form.canCreate && existing === null)
      throw new AppError("FORBIDDEN", "The provider does not permit onboarding for this account");
    const claimed =
      existing === null
        ? await this.repository.claim(scope, { moderatorGuid: moderator.guid, entityType })
        : existing;
    if (claimed === null)
      throw conflict("Another request already claimed this onboarding customer");
    try {
      const result = await this.provider.saveOnboardingApplication(this.runtime, {
        entityType,
        application: request.application,
        documents,
        linkedOrganizationGuid: claimed.organization_guid,
      });
      if (existing === null) await this.link(scope, claimed, result);
      else if (result.organizationGuid !== existing.organization_guid)
        throw internalError("The provider changed an existing customer identity");
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
    const documents: Record<string, { blobPath: string; originalFilename?: string }> = {};
    if (references === undefined) return documents;
    if (entityType !== "business")
      throw badRequest("Individual onboarding does not accept business documents");
    const fields = this.provider.onboardingApplicationFields(entityType);
    for (const [key, id] of Object.entries(references)) {
      if (fields.has(key)) throw badRequest("Document slot overlaps an application field");
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
    const reference = this.provider.onboardingRecoveryReferences(cause);
    if (claimed.entity_type === "business" && reference.organizationGuid !== undefined) {
      await this.link(scope, claimed, { organizationGuid: reference.organizationGuid });
    }
    if (claimed.entity_type === "individual" && reference.personGuid !== undefined) {
      await this.link(scope, claimed, { personGuid: reference.personGuid });
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
    const detail = await this.provider.getOnboardingCustomerDetail(this.runtime, {
      entityType: row.entity_type,
      reference: guid,
    });
    if (detail.reference !== guid) throw internalError("The provider returned another customer");
    // Detailed API statuses are open strings. A new status is never approval.
    return {
      counterpartyId: scope.counterpartyId,
      state: row.status,
      providerStatus: detail.providerStatus,
      organizationGuid: row.organization_guid,
      personGuid: row.person_guid,
      corrections: detail.corrections,
      correctionDueAt: detail.correctionDueAt,
    };
  }

  async registerWallet(scope: EarnOnboardingScope, owner: string, signature?: string) {
    const { row, moderator } = await this.customer(scope);
    if (row.status !== "linked" || row.organization_guid === null)
      throw conflict("A linked business customer is required");
    // Control of the address must be proven before anything is claimed or
    // written. The claim is unique per environment and provider, and the
    // provider's registrations are accepted immediately, so an unproven
    // caller could block the address's real owner forever.
    await this.assertControlProven(scope, owner, signature);
    if (!moderator.clientOrganizations.some((child) => child.guid === row.organization_guid)) {
      throw conflict("Onboarding customer is not assigned to the configured provider identity");
    }
    const detail = await this.provider.getOnboardingCustomerDetail(this.runtime, {
      entityType: row.entity_type,
      reference: row.organization_guid,
    });
    if (detail.reference !== row.organization_guid || detail.providerStatus !== "active")
      throw conflict("Onboarding customer verification is not active");
    if (!(await this.repository.claimWallet(scope, owner)))
      throw conflict("Wallet onboarding already claimed; reconcile before retrying");
    try {
      await this.provider.registerOnboardingWallet(this.runtime, {
        reference: row.organization_guid,
        owner,
      });
    } catch (error) {
      // The address is unique per environment and provider across every
      // customer. A confirmed rejection releases the unverified claim so it
      // cannot block the real owner; an uncertain outcome (timeout, 5xx,
      // malformed reply) keeps the claim — the provider may have accepted
      // the wallet.
      if (error instanceof SdpEarnError && isConfirmedWalletRejection(error))
        await this.repository.releaseWallet(scope, owner);
      throw error;
    }
    if (!(await this.repository.linkWallet(scope, owner)))
      throw internalError("Wallet registration could not be recorded; reconcile before retrying");
    return { counterpartyId: scope.counterpartyId, owner, registered: true };
  }

  async upload(scope: EarnOnboardingScope, document: { documentType: string; file: File }) {
    const moderator = await this.provider.getOnboardingModerator(this.runtime);
    const existing = await this.repository.get(scope);
    if (
      existing !== null &&
      (existing.moderator_guid !== moderator.guid || existing.status === "archived")
    )
      throw conflict("Onboarding customer cannot accept documents");
    const reference = await this.provider.uploadOnboardingDocument(this.runtime, document);
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
    const parsed = storedDocumentReferenceSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw internalError("Onboarding document reference is invalid");
    return parsed.data;
  }

  async correct(
    scope: EarnOnboardingScope,
    reasonId: number,
    answer: {
      values?: Record<string, unknown>;
      explanation?: string;
      attested?: boolean;
      documentId?: string;
    }
  ) {
    const { row } = await this.customer(scope);
    if (row.status !== "linked" || row.organization_guid === null)
      throw conflict("A linked business application is required");
    const { documentId, ...body } = answer;
    const answerForProvider: {
      values?: Record<string, unknown>;
      explanation?: string;
      attested?: boolean;
      document?: string;
    } = body;
    if (documentId !== undefined)
      answerForProvider.document = (await this.document(scope, documentId)).blobPath;
    await this.provider.answerOnboardingCorrection(this.runtime, {
      reference: row.organization_guid,
      reasonId,
      answer: answerForProvider,
    });
    return { counterpartyId: scope.counterpartyId, reasonId, answered: true };
  }
}
