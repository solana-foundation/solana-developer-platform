import type {
  CounterpartyBusinessIdentity,
  CounterpartyIndividualIdentity,
  CounterpartyProviderData,
  CounterpartyStatus,
} from "@sdp/types";

/**
 * Persisted counterparty row shape shared between the API's counterparty
 * repository and the ramp provider validation/provider-data helpers.
 */
export type CounterpartyRow = {
  id: string;
  organization_id: string;
  project_id: string;
  external_id: string | null;
  display_name: string;
  email: string;
  provider_data: CounterpartyProviderData;
  status: CounterpartyStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
} & (
  | { entity_type: "individual"; identity: CounterpartyIndividualIdentity }
  | { entity_type: "business"; identity: CounterpartyBusinessIdentity }
);
