import { COUNTERPARTY_ENTITY_TYPES } from "@sdp/types";
import type {
  ApiPlaygroundEndpointConfig,
  ApiPlaygroundFieldConfig,
} from "@/components/api-playground-shell";
import { toTitleCase } from "../../activity-format-utils";

export interface CounterpartyPlaygroundView {
  id: string;
  displayName: string;
}

const entityTypeOptions = COUNTERPARTY_ENTITY_TYPES.map((value) => ({
  label: toTitleCase(value),
  value,
}));

const exampleCounterpartyId = "cpty_abc123";
const exampleDisplayName = "Acme Corp";
const exampleEmail = "contact@acme.com";

function buildCounterpartyIdField(): ApiPlaygroundFieldConfig {
  return {
    key: "counterpartyId",
    // biome-ignore lint/security/noSecrets: URL path placeholder, not a secret.
    label: "{counterpartyId}",
    placeholder: "Counterparty ID (e.g. cpty_abc123)",
    required: true,
  };
}

export function buildCounterpartyPlaygroundEndpointConfigs(
  counterparties: CounterpartyPlaygroundView[]
): ApiPlaygroundEndpointConfig[] {
  const counterpartyOptions = counterparties.map((cp) => ({
    value: cp.id,
    label: cp.displayName,
  }));

  const counterpartyIdField: ApiPlaygroundFieldConfig =
    counterpartyOptions.length > 0
      ? {
          key: "counterpartyId",
          // biome-ignore lint/security/noSecrets: URL path placeholder, not a secret.
          label: "{counterpartyId}",
          placeholder: "Counterparty ID (e.g. cpty_abc123)",
          kind: "select",
          options: counterpartyOptions,
          defaultValue: counterpartyOptions[0]?.value ?? "",
          required: true,
        }
      : buildCounterpartyIdField();

  const firstId = counterparties[0]?.id ?? exampleCounterpartyId;
  const firstName = counterparties[0]?.displayName ?? exampleDisplayName;

  return [
    {
      id: "list-counterparties",
      title: "List Counterparties",
      method: "GET",
      path: "/v1/counterparties",
      pathFields: [],
      bodyFields: [],
      expectedResponse: {
        counterparties:
          counterparties.length > 0
            ? counterparties.map((cp) => ({ id: cp.id, displayName: cp.displayName }))
            : [{ id: exampleCounterpartyId, displayName: exampleDisplayName, email: exampleEmail }],
        total: counterparties.length || 1,
        page: 1,
        pageSize: 100,
      },
    },
    {
      id: "get-counterparty",
      title: "Get Counterparty",
      method: "GET",
      // biome-ignore lint/security/noSecrets: URL path placeholder, not a secret.
      path: "/v1/counterparties/{counterpartyId}",
      pathFields: [counterpartyIdField],
      bodyFields: [],
      expectedResponse: {
        counterparty: {
          id: firstId,
          displayName: firstName,
          email: exampleEmail,
          entityType: "business",
          status: "active",
        },
      },
    },
    {
      id: "create-counterparty",
      title: "Create Counterparty",
      method: "POST",
      path: "/v1/counterparties",
      pathFields: [],
      bodyFields: [
        {
          key: "displayName",
          label: "displayName",
          placeholder: "Acme Corp",
          defaultValue: exampleDisplayName,
          required: true,
        },
        {
          key: "email",
          label: "email",
          placeholder: "contact@acme.com",
          defaultValue: exampleEmail,
          required: true,
        },
        {
          key: "entityType",
          label: "entityType",
          placeholder: "Select entity type",
          kind: "select",
          options: entityTypeOptions,
          defaultValue: "business",
          required: true,
        },
        {
          key: "externalId",
          label: "externalId",
          placeholder: "Your internal reference ID",
        },
      ],
      expectedResponse: {
        counterparty: {
          id: exampleCounterpartyId,
          displayName: exampleDisplayName,
          email: exampleEmail,
          entityType: "business",
          status: "active",
          createdAt: new Date().toISOString(),
        },
      },
    },
    {
      id: "update-counterparty",
      title: "Update Counterparty",
      method: "PATCH",
      // biome-ignore lint/security/noSecrets: URL path placeholder, not a secret.
      path: "/v1/counterparties/{counterpartyId}",
      pathFields: [counterpartyIdField],
      bodyFields: [
        {
          key: "displayName",
          label: "displayName",
          placeholder: "Updated display name",
        },
        {
          key: "email",
          label: "email",
          placeholder: "updated@example.com",
        },
        {
          key: "entityType",
          label: "entityType",
          placeholder: "Select entity type",
          kind: "select",
          options: entityTypeOptions,
        },
        {
          key: "externalId",
          label: "externalId",
          placeholder: "Your internal reference ID",
        },
      ],
      expectedResponse: {
        counterparty: {
          id: firstId,
          displayName: firstName,
          email: exampleEmail,
          entityType: "business",
          status: "active",
        },
      },
    },
    {
      id: "delete-counterparty",
      title: "Delete Counterparty",
      method: "DELETE",
      // biome-ignore lint/security/noSecrets: URL path placeholder, not a secret.
      path: "/v1/counterparties/{counterpartyId}",
      pathFields: [counterpartyIdField],
      bodyFields: [],
      expectedResponse: {
        deleted: true,
        counterpartyId: firstId,
      },
    },
  ];
}
