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

/**
 * Generates a new SDP counterparty primary key.
 *
 * @returns A counterparty id in `cpty_<uuid>` format.
 */
export function generateCounterpartyId(): string {
  return `cpty_${crypto.randomUUID()}`;
}

/**
 * Matches the uuid segments of an SDP counterparty id in `cpty_<uuid>` format.
 */
export const SDP_COUNTERPARTY_ID_PATTERN =
  /^cpty_([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i;
