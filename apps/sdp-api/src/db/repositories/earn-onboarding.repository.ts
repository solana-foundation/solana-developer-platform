import { SDP_ENVIRONMENTS, type SdpEnvironment } from "@sdp/types/api-keys";
import { COUNTERPARTY_ENTITY_TYPES, type CounterpartyEntityType } from "@sdp/types/counterparties";
import { EARN_ONBOARDING_STATES } from "@sdp/types/earn-onboarding";
import { z } from "zod";

export interface EarnOnboardingScope {
  organizationId: string;
  projectId: string;
  environment: SdpEnvironment;
  counterpartyId: string;
}
export const earnOnboardingCustomerSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  project_id: z.string(),
  environment: z.enum(SDP_ENVIRONMENTS),
  counterparty_id: z.string(),
  entity_type: z.enum(COUNTERPARTY_ENTITY_TYPES),
  moderator_guid: z.uuid(),
  organization_guid: z.uuid().nullable(),
  person_guid: z.uuid().nullable(),
  status: z.enum(EARN_ONBOARDING_STATES),
  created_at: z.string(),
  updated_at: z.string(),
});
export type EarnOnboardingCustomer = z.infer<typeof earnOnboardingCustomerSchema>;
export interface EarnOnboardingRepository {
  get(scope: EarnOnboardingScope): Promise<EarnOnboardingCustomer | null>;
  claim(
    scope: EarnOnboardingScope,
    input: { moderatorGuid: string; entityType: CounterpartyEntityType }
  ): Promise<EarnOnboardingCustomer | null>;
  link(
    scope: EarnOnboardingScope,
    input: { moderatorGuid: string; organizationGuid: string | null; personGuid: string | null }
  ): Promise<EarnOnboardingCustomer | null>;
  claimWallet(scope: EarnOnboardingScope, owner: string): Promise<boolean>;
  /** Archives an unverified claim so a rejected registration cannot block the real owner. */
  releaseWallet(scope: EarnOnboardingScope, owner: string): Promise<void>;
  linkWallet(scope: EarnOnboardingScope, owner: string): Promise<boolean>;
  findByWallet(
    scope: Omit<EarnOnboardingScope, "counterpartyId">,
    owner: string
  ): Promise<EarnOnboardingCustomer | null>;
  saveDocument(scope: EarnOnboardingScope, encryptedReference: string): Promise<string>;
  getDocument(scope: EarnOnboardingScope, documentId: string): Promise<string | null>;
}
