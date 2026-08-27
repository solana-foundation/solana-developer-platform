import type {
  CounterpartyEntityType,
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
  entity_type: CounterpartyEntityType;
  display_name: string;
  provider_data: CounterpartyProviderData;
  status: CounterpartyStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

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
