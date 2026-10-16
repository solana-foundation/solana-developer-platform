import { COUNTERPARTY_ENTITY_TYPES } from "@sdp/types";
import type {
  ApiPlaygroundEndpointConfig,
  ApiPlaygroundFieldConfig,
} from "@/components/api-playground-shell";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import { mergeOpenApiPlaygroundEndpoints } from "@/lib/api-playground-openapi-catalog";

export interface CounterpartyPlaygroundView {
  id: string;
  displayName: string;
}

const exampleCounterpartyId = "cpty_abc123";
const exampleDisplayName = "Acme Corp";

type Translate = (key: MessageKey, values?: TranslationValues) => string;
const counterpartyIdPathLabel = ["{", "counterpartyId", "}"].join("");

function buildCounterpartyIdField(t: Translate): ApiPlaygroundFieldConfig {
  return {
    key: "counterpartyId",
    label: counterpartyIdPathLabel,
    placeholder: t("DashboardPayments.counterparty.playgroundCounterpartyIdPlaceholder"),
    required: true,
  };
}

export function buildCounterpartyPlaygroundEndpointConfigs(
  counterparties: CounterpartyPlaygroundView[],
  t: Translate
): ApiPlaygroundEndpointConfig[] {
  const entityTypeOptions = COUNTERPARTY_ENTITY_TYPES.map((value) => ({
    label:
      value === "individual"
        ? t("DashboardPayments.counterparty.individual")
        : t("DashboardPayments.counterparty.business"),
    value,
  }));
  const counterpartyOptions = counterparties.map((cp) => ({
    value: cp.id,
    label: cp.displayName,
  }));
  const firstCounterpartyOption = counterpartyOptions[0];
  const counterpartyIdField: ApiPlaygroundFieldConfig =
    firstCounterpartyOption === undefined
      ? buildCounterpartyIdField(t)
      : {
          key: "counterpartyId",
          label: counterpartyIdPathLabel,
          placeholder: t("DashboardPayments.counterparty.playgroundCounterpartyIdPlaceholder"),
          kind: "select",
          options: counterpartyOptions,
          defaultValue: firstCounterpartyOption.value,
          required: true,
        };

  const firstId = counterparties[0]?.id ?? exampleCounterpartyId;
  const firstName = counterparties[0]?.displayName ?? exampleDisplayName;

  const curatedEndpoints: ApiPlaygroundEndpointConfig[] = [
    {
      id: "list-counterparties",
      title: t("DashboardPayments.counterparty.listCounterparties"),
      method: "GET",
      path: "/v1/counterparties",
      pathFields: [],
      bodyFields: [],
      expectedResponse: {
        counterparties:
          counterparties.length > 0
            ? counterparties.map((cp) => ({ id: cp.id, displayName: cp.displayName }))
            : [{ id: exampleCounterpartyId, displayName: exampleDisplayName }],
        total: counterparties.length || 1,
        page: 1,
        pageSize: 100,
      },
    },
    {
      id: "get-counterparty",
      title: t("DashboardPayments.counterparty.getCounterparty"),
      method: "GET",
      path: "/v1/counterparties/{counterpartyId}",
      pathFields: [counterpartyIdField],
      bodyFields: [],
      expectedResponse: {
        counterparty: {
          id: firstId,
          displayName: firstName,
          entityType: "business",
          status: "active",
        },
      },
    },
    {
      id: "create-counterparty",
      title: t("DashboardPayments.counterparty.createCounterparty"),
      method: "POST",
      path: "/v1/counterparties",
      pathFields: [],
      bodyFields: [
        {
          key: "displayName",
          label: "displayName",
          placeholder: t("DashboardPayments.counterparty.businessNamePlaceholder"),
          defaultValue: exampleDisplayName,
          required: true,
        },
        {
          key: "entityType",
          label: "entityType",
          placeholder: t("DashboardPayments.counterparty.selectEntityType"),
          kind: "select",
          options: entityTypeOptions,
          defaultValue: "business",
          required: true,
        },
        {
          key: "externalId",
          label: "externalId",
          placeholder: t("DashboardPayments.counterparty.externalIdPlaceholder"),
        },
      ],
      expectedResponse: {
        counterparty: {
          id: exampleCounterpartyId,
          displayName: exampleDisplayName,
          entityType: "business",
          status: "active",
          createdAt: new Date().toISOString(),
        },
      },
    },
    {
      id: "update-counterparty",
      title: t("DashboardPayments.counterparty.updateCounterparty"),
      method: "PATCH",
      path: "/v1/counterparties/{counterpartyId}",
      pathFields: [counterpartyIdField],
      bodyFields: [
        {
          key: "displayName",
          label: "displayName",
          placeholder: t("DashboardPayments.counterparty.updatedDisplayNamePlaceholder"),
        },
        {
          key: "entityType",
          label: "entityType",
          placeholder: t("DashboardPayments.counterparty.selectEntityType"),
          kind: "select",
          options: entityTypeOptions,
        },
        {
          key: "externalId",
          label: "externalId",
          placeholder: t("DashboardPayments.counterparty.externalIdPlaceholder"),
        },
      ],
      expectedResponse: {
        counterparty: {
          id: firstId,
          displayName: firstName,
          entityType: "business",
          status: "active",
        },
      },
    },
    {
      id: "delete-counterparty",
      title: t("DashboardPayments.counterparty.deleteCounterparty"),
      method: "DELETE",
      path: "/v1/counterparties/{counterpartyId}",
      pathFields: [counterpartyIdField],
      bodyFields: [],
      expectedResponse: {
        deleted: true,
        counterpartyId: firstId,
      },
    },
  ];

  return mergeOpenApiPlaygroundEndpoints("counterparties", curatedEndpoints);
}
