import { COUNTERPARTY_ENTITY_TYPES } from "@sdp/types";
import type {
  ApiPlaygroundEndpointConfig,
  ApiPlaygroundFieldConfig,
} from "@/components/api-playground-shell";
import type { MessageKey, TranslationValues } from "@/i18n/messages";

export interface CounterpartyPlaygroundView {
  id: string;
  displayName: string;
}

const exampleCounterpartyId = "cpty_abc123";
const exampleDisplayName = "Acme Corp";
const exampleEmail = "contact@acme.com";
const exampleAddress = {
  line1: "123 Main St",
  city: "San Francisco",
  postalCode: "94105",
  countryCode: "US",
  subdivisionCode: "CA",
};

type Translate = (key: MessageKey, values?: TranslationValues) => string;

function buildCounterpartyIdField(t: Translate): ApiPlaygroundFieldConfig {
  return {
    key: "counterpartyId",
    label: "{counterpartyId}",
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
  const individualOnlyDescription = t("DashboardPayments.counterparty.playgroundIndividualOnly");
  const addressRequiredDescription = t("DashboardPayments.counterparty.playgroundAddressRequired");

  const counterpartyIdField: ApiPlaygroundFieldConfig =
    counterpartyOptions.length > 0
      ? {
          key: "counterpartyId",
          label: "{counterpartyId}",
          placeholder: t("DashboardPayments.counterparty.playgroundCounterpartyIdPlaceholder"),
          kind: "select",
          options: counterpartyOptions,
          defaultValue: counterpartyOptions[0]?.value ?? "",
          required: true,
        }
      : buildCounterpartyIdField(t);

  const firstId = counterparties[0]?.id ?? exampleCounterpartyId;
  const firstName = counterparties[0]?.displayName ?? exampleDisplayName;

  return [
    {
      id: "list-counterparties",
      title: t("DashboardPayments.counterparty.listCounterparties"),
      method: "GET",
      path: "/v1/counterparties",
      pathFields: [],
      bodyFields: [],
      expectedResponse: {
        data:
          counterparties.length > 0
            ? counterparties.map((cp) => ({ id: cp.id, displayName: cp.displayName }))
            : [{ id: exampleCounterpartyId, displayName: exampleDisplayName, email: exampleEmail }],
        meta: {
          total: counterparties.length || 1,
          page: 1,
          pageSize: 20,
          hasMore: false,
        },
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
          email: exampleEmail,
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
          key: "email",
          label: "email",
          placeholder: t("DashboardPayments.counterparty.playgroundEmailPlaceholder"),
          defaultValue: exampleEmail,
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
          key: "identity.firstName",
          label: "identity.firstName",
          placeholder: t("DashboardPayments.counterparty.firstNamePlaceholder"),
          description: individualOnlyDescription,
        },
        {
          key: "identity.lastName",
          label: "identity.lastName",
          placeholder: t("DashboardPayments.counterparty.lastNamePlaceholder"),
          description: individualOnlyDescription,
        },
        {
          key: "identity.dateOfBirth",
          label: "identity.dateOfBirth",
          placeholder: t("DashboardPayments.counterparty.playgroundDateOfBirthPlaceholder"),
          description: individualOnlyDescription,
        },
        {
          key: "identity.phone",
          label: "identity.phone",
          placeholder: t("DashboardPayments.counterparty.playgroundPhonePlaceholder"),
          description: individualOnlyDescription,
        },
        {
          key: "identity.address.line1",
          label: "identity.address.line1",
          defaultValue: exampleAddress.line1,
          description: addressRequiredDescription,
          required: true,
        },
        {
          key: "identity.address.line2",
          label: "identity.address.line2",
        },
        {
          key: "identity.address.city",
          label: "identity.address.city",
          defaultValue: exampleAddress.city,
          description: addressRequiredDescription,
          required: true,
        },
        {
          key: "identity.address.postalCode",
          label: "identity.address.postalCode",
          defaultValue: exampleAddress.postalCode,
        },
        {
          key: "identity.address.countryCode",
          label: "identity.address.countryCode",
          defaultValue: exampleAddress.countryCode,
          description: addressRequiredDescription,
          required: true,
        },
        {
          key: "identity.address.subdivisionCode",
          label: "identity.address.subdivisionCode",
          defaultValue: exampleAddress.subdivisionCode,
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
          email: exampleEmail,
          entityType: "business",
          identity: { address: exampleAddress },
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
          key: "email",
          label: "email",
          placeholder: t("DashboardPayments.counterparty.updatedEmailPlaceholder"),
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
          email: exampleEmail,
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
}
