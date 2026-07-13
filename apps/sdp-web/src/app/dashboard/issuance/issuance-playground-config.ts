import type {
  ApiPlaygroundEndpointConfig,
  ApiPlaygroundFieldConfig,
  ApiPlaygroundFieldOption,
} from "@/components/api-playground-shell";
import type { MessageKey } from "@/i18n/messages";
import { getTokenAmountFieldDescription } from "./[tokenId]/token-management-workspace.utils";

export interface IssuancePlaygroundTokenView {
  id: string;
  name: string;
  symbol: string;
  mintAddress: string | null;
}

export interface IssuancePlaygroundTemplateView {
  id: string;
  name: string;
}

interface BuildIssuancePlaygroundConfigOptions {
  templates: IssuancePlaygroundTemplateView[];
  tokens: IssuancePlaygroundTokenView[];
  t: (key: MessageKey) => string;
}

function buildPriorityFeeOptions(t: (key: MessageKey) => string): ApiPlaygroundFieldOption[] {
  return [
    { value: "none", label: t("DashboardIssuance.playground.none") },
    { value: "low", label: t("DashboardIssuance.playground.low") },
    { value: "medium", label: t("DashboardIssuance.playground.medium") },
    { value: "high", label: t("DashboardIssuance.playground.high") },
  ];
}

function buildSimulateOptions(t: (key: MessageKey) => string): ApiPlaygroundFieldOption[] {
  return [
    { label: t("DashboardIssuance.playground.true"), value: "true" },
    { label: t("DashboardIssuance.playground.false"), value: "false" },
  ];
}

function buildTokenStatusOptions(t: (key: MessageKey) => string): ApiPlaygroundFieldOption[] {
  return [
    { label: t("DashboardIssuance.playground.active"), value: "active" },
    { label: t("DashboardIssuance.playground.paused"), value: "paused" },
  ];
}

function buildAuthorityRoleOptions(t: (key: MessageKey) => string): ApiPlaygroundFieldOption[] {
  return [
    { label: t("DashboardIssuance.playground.authorityRoleMint"), value: "mint" },
    { label: t("DashboardIssuance.playground.authorityRoleFreeze"), value: "freeze" },
    {
      label: t("DashboardIssuance.playground.authorityRolePermanentDelegate"),
      value: "permanentDelegate",
    },
    { label: t("DashboardIssuance.playground.authorityRoleMetadata"), value: "metadata" },
  ];
}

const exampleTokenAccountAddress = "1".repeat(32);
const exampleWalletAddress = "2".repeat(32);

function buildTokenAmountField(
  key: string,
  label: string,
  t: (key: MessageKey) => string,
  defaultValue = "1000"
): ApiPlaygroundFieldConfig {
  return {
    key,
    label,
    defaultValue,
    placeholder: t("DashboardIssuance.playground.amountPlaceholder"),
    description: getTokenAmountFieldDescription(t),
    required: true,
  };
}

function buildTokenOptions(tokens: IssuancePlaygroundTokenView[]): ApiPlaygroundFieldOption[] {
  return tokens.map((token) => ({
    value: token.id,
    label: `${token.name} (${token.symbol})`,
  }));
}

function buildTemplateOptions(
  templates: IssuancePlaygroundTemplateView[]
): ApiPlaygroundFieldOption[] {
  return templates.map((template) => ({
    value: template.id,
    label: template.name,
  }));
}

function buildSelectBackedField(
  key: string,
  label: string,
  placeholder: string,
  options: ApiPlaygroundFieldOption[],
  required = true
): ApiPlaygroundFieldConfig {
  if (options.length === 0) {
    return {
      key,
      label,
      placeholder,
      required,
    };
  }

  return {
    key,
    label,
    placeholder,
    kind: "select",
    options,
    defaultValue: options[0]?.value ?? "",
    required,
  };
}

function buildPriorityFields(t: (key: MessageKey) => string): ApiPlaygroundFieldConfig[] {
  return [
    {
      key: "options.priorityFee",
      label: "options.priorityFee",
      placeholder: t("DashboardIssuance.playground.selectPriorityFee"),
      kind: "select",
      options: buildPriorityFeeOptions(t),
    },
    {
      key: "options.simulate",
      label: "options.simulate",
      placeholder: t("DashboardIssuance.playground.selectSimulate"),
      kind: "select",
      options: buildSimulateOptions(t),
      valueType: "boolean",
    },
  ];
}

export function buildIssuancePlaygroundEndpointConfigs({
  templates,
  tokens,
  t,
}: BuildIssuancePlaygroundConfigOptions): ApiPlaygroundEndpointConfig[] {
  const tokenOptions = buildTokenOptions(tokens);
  const templateOptions = buildTemplateOptions(templates);
  const authorityRoleOptions = buildAuthorityRoleOptions(t);
  const firstToken = tokens[0];
  const firstTemplate = templates[0];
  const tokenIdField = buildSelectBackedField(
    "tokenId",
    "{tokenId}",
    t("DashboardIssuance.playground.tokenIdPlaceholder"),
    tokenOptions
  );
  const templateIdField = buildSelectBackedField(
    "templateId",
    "{templateId}",
    t("DashboardIssuance.playground.templateIdPlaceholder"),
    templateOptions
  );
  const exampleTokenId = firstToken?.id ?? "tok_abc123";
  const exampleTokenName = firstToken?.name ?? "Acme Dollar";
  const exampleTokenSymbol = firstToken?.symbol ?? "ACME";
  const exampleTemplateId = firstTemplate?.id ?? "stablecoin";
  const exampleTemplateName = firstTemplate?.name ?? "Stablecoin";

  return [
    {
      id: "list-templates",
      title: t("DashboardIssuance.playground.listTemplates"),
      method: "GET",
      path: "/v1/issuance/templates",
      pathFields: [],
      bodyFields: [],
      expectedResponse: {
        data: {
          templates:
            templates.length > 0
              ? templates.map((template) => ({
                  id: template.id,
                  name: template.name,
                }))
              : [
                  {
                    id: exampleTemplateId,
                    name: exampleTemplateName,
                  },
                ],
        },
      },
    },
    {
      id: "get-template",
      title: t("DashboardIssuance.playground.getTemplate"),
      method: "GET",
      path: "/v1/issuance/templates/{templateId}",
      pathFields: [templateIdField],
      bodyFields: [],
      expectedResponse: {
        data: {
          id: exampleTemplateId,
          name: exampleTemplateName,
          defaultDecimals: 6,
          requiredExtensions: ["transferFee"],
          optionalExtensions: ["pausable"],
        },
      },
    },
    {
      id: "create-token",
      title: t("DashboardIssuance.playground.createToken"),
      method: "POST",
      path: "/v1/issuance/tokens",
      pathFields: [],
      bodyFields: [
        {
          key: "name",
          label: "name",
          placeholder: t("DashboardIssuance.playground.tokenNameExample"),
          defaultValue: exampleTokenName,
          required: true,
        },
        {
          key: "symbol",
          label: "symbol",
          placeholder: t("DashboardIssuance.playground.tokenSymbolExample"),
          defaultValue: exampleTokenSymbol,
          required: true,
        },
        {
          key: "template",
          label: "template",
          placeholder: t("DashboardIssuance.playground.selectTemplate"),
          kind: templateOptions.length > 0 ? "select" : "text",
          options: templateOptions,
          defaultValue: firstTemplate?.id ?? "custom",
        },
        {
          key: "decimals",
          label: "decimals",
          placeholder: "6",
          defaultValue: "6",
          valueType: "number",
        },
        {
          key: "description",
          label: "description",
          placeholder: t("DashboardIssuance.playground.settlementAssetExample"),
          defaultValue: t("DashboardIssuance.playground.settlementAssetExample"),
        },
        {
          key: "uri",
          label: t("DashboardIssuance.playground.optionalHostedUri"),
          placeholder: t("DashboardIssuance.playground.metadataUriExample"),
        },
      ],
      expectedResponse: {
        data: {
          token: {
            id: exampleTokenId,
            name: exampleTokenName,
            symbol: exampleTokenSymbol,
            status: "pending",
            deployedAt: null,
          },
        },
      },
    },
    {
      id: "list-tokens",
      title: t("DashboardIssuance.playground.listTokens"),
      method: "GET",
      path: "/v1/issuance/tokens",
      pathFields: [],
      bodyFields: [],
      expectedResponse: {
        data:
          tokens.length > 0
            ? tokens.map((token) => ({
                id: token.id,
                name: token.name,
                symbol: token.symbol,
                mintAddress: token.mintAddress,
              }))
            : [
                {
                  id: exampleTokenId,
                  name: exampleTokenName,
                  symbol: exampleTokenSymbol,
                  mintAddress: firstToken?.mintAddress ?? null,
                },
              ],
      },
    },
    {
      id: "get-token",
      title: t("DashboardIssuance.playground.getToken"),
      method: "GET",
      path: "/v1/issuance/tokens/{tokenId}",
      pathFields: [tokenIdField],
      bodyFields: [],
      expectedResponse: {
        data: {
          id: exampleTokenId,
          name: exampleTokenName,
          symbol: exampleTokenSymbol,
          status: "active",
          mintAddress: firstToken?.mintAddress ?? "mint_acme_primary",
          totalSupply: "1250000",
        },
      },
    },
    {
      id: "update-token",
      title: t("DashboardIssuance.playground.updateToken"),
      method: "PATCH",
      path: "/v1/issuance/tokens/{tokenId}",
      pathFields: [tokenIdField],
      bodyFields: [
        {
          key: "name",
          label: "name",
          placeholder: t("DashboardIssuance.playground.updatedTokenName"),
        },
        {
          key: "description",
          label: "description",
          placeholder: t("DashboardIssuance.playground.updatedTokenDescription"),
        },
        {
          key: "uri",
          label: "uri",
          placeholder: t("DashboardIssuance.playground.updatedMetadataUri"),
        },
        {
          key: "imageUrl",
          label: "imageUrl",
          placeholder: t("DashboardIssuance.playground.tokenImageUrl"),
        },
        {
          key: "status",
          label: "status",
          placeholder: t("DashboardIssuance.playground.selectStatus"),
          kind: "select",
          options: buildTokenStatusOptions(t),
        },
      ],
      expectedResponse: {
        data: {
          token: {
            id: exampleTokenId,
            name: exampleTokenName,
            status: "active",
          },
        },
      },
    },
    {
      id: "list-transactions",
      title: t("DashboardIssuance.playground.listTokenTransactions"),
      method: "GET",
      path: "/v1/issuance/tokens/{tokenId}/transactions",
      pathFields: [tokenIdField],
      bodyFields: [],
      expectedResponse: {
        data: {
          items: [
            {
              id: "tx_abc123",
              tokenId: exampleTokenId,
              type: "mint",
              status: "confirmed",
              signature: "5P7B...",
            },
          ],
        },
      },
    },
    {
      id: "refresh-supply",
      title: t("DashboardIssuance.playground.refreshTotalSupply"),
      method: "POST",
      path: "/v1/issuance/tokens/{tokenId}/supply/refresh",
      pathFields: [tokenIdField],
      bodyFields: [],
      expectedResponse: {
        data: {
          token: {
            id: exampleTokenId,
            totalSupply: "1250000",
            totalSupplyUpdatedAt: "2026-02-17T12:00:00.000Z",
          },
        },
      },
    },
    {
      id: "deploy-token",
      title: t("DashboardIssuance.playground.deployToken"),
      method: "POST",
      path: "/v1/issuance/tokens/{tokenId}/deploy",
      pathFields: [tokenIdField],
      bodyFields: [],
      expectedResponse: {
        data: {
          token: {
            id: exampleTokenId,
            status: "active",
            mintAddress: firstToken?.mintAddress ?? "mint_acme_primary",
          },
        },
      },
    },
    {
      id: "mint-execute",
      title: t("DashboardIssuance.playground.mintTokens"),
      method: "POST",
      path: "/v1/issuance/tokens/{tokenId}/mint",
      pathFields: [tokenIdField],
      bodyFields: [
        {
          key: "mint.destination",
          label: "mint.destination",
          placeholder: t("DashboardIssuance.playground.solanaAddressPlaceholder"),
          required: true,
        },
        buildTokenAmountField("mint.amount", "mint.amount", t),
        {
          key: "mint.memo",
          label: "mint.memo",
          placeholder: t("DashboardIssuance.playground.optionalMemo"),
        },
        ...buildPriorityFields(t),
      ],
      expectedResponse: {
        data: {
          transaction: {
            id: "tx_mint_live_123",
            tokenId: exampleTokenId,
            type: "mint",
            status: "processing",
          },
        },
      },
    },
    {
      id: "burn-execute",
      title: t("DashboardIssuance.playground.burnTokens"),
      method: "POST",
      path: "/v1/issuance/tokens/{tokenId}/burn",
      pathFields: [tokenIdField],
      bodyFields: [
        {
          key: "burn.source",
          label: "burn.source",
          placeholder: t("DashboardIssuance.playground.tokenAccountAddressPlaceholder"),
          required: true,
        },
        buildTokenAmountField("burn.amount", "burn.amount", t),
        {
          key: "burn.memo",
          label: "burn.memo",
          placeholder: t("DashboardIssuance.playground.optionalMemo"),
        },
        ...buildPriorityFields(t),
      ],
      expectedResponse: {
        data: {
          transaction: {
            id: "tx_burn_live_123",
            tokenId: exampleTokenId,
            type: "burn",
            status: "processing",
          },
        },
      },
    },
    {
      id: "seize-execute",
      title: t("DashboardIssuance.playground.seizeTokens"),
      method: "POST",
      path: "/v1/issuance/tokens/{tokenId}/seize",
      pathFields: [tokenIdField],
      bodyFields: [
        {
          key: "seize.source",
          label: "seize.source",
          placeholder: t("DashboardIssuance.playground.sourceTokenAccountAddress"),
          required: true,
        },
        {
          key: "seize.destination",
          label: "seize.destination",
          placeholder: t("DashboardIssuance.playground.destinationTokenAccountAddress"),
          required: true,
        },
        buildTokenAmountField("seize.amount", "seize.amount", t, "250"),
        {
          key: "seize.delegateAuthority",
          label: "seize.delegateAuthority",
          placeholder: t("DashboardIssuance.playground.delegateAuthorityAddress"),
        },
        {
          key: "seize.memo",
          label: "seize.memo",
          placeholder: t("DashboardIssuance.playground.optionalMemo"),
        },
        ...buildPriorityFields(t),
      ],
      expectedResponse: {
        data: {
          transaction: {
            id: "tx_seize_live_123",
            tokenId: exampleTokenId,
            type: "seize",
            status: "processing",
          },
        },
      },
    },
    {
      id: "force-burn-execute",
      title: t("DashboardIssuance.playground.forceBurn"),
      method: "POST",
      path: "/v1/issuance/tokens/{tokenId}/force-burn",
      pathFields: [tokenIdField],
      bodyFields: [
        {
          key: "forceBurn.source",
          label: "forceBurn.source",
          placeholder: t("DashboardIssuance.playground.tokenAccountAddress"),
          required: true,
        },
        buildTokenAmountField("forceBurn.amount", "forceBurn.amount", t, "250"),
        {
          key: "forceBurn.delegateAuthority",
          label: "forceBurn.delegateAuthority",
          placeholder: t("DashboardIssuance.playground.delegateAuthorityAddress"),
        },
        {
          key: "forceBurn.memo",
          label: "forceBurn.memo",
          placeholder: t("DashboardIssuance.playground.optionalMemo"),
        },
        ...buildPriorityFields(t),
      ],
      expectedResponse: {
        data: {
          transaction: {
            id: "tx_force_burn_live_123",
            tokenId: exampleTokenId,
            type: "force_burn",
            status: "processing",
          },
        },
      },
    },
    {
      id: "authority-execute",
      title: t("DashboardIssuance.playground.updateAuthority"),
      method: "POST",
      path: "/v1/issuance/tokens/{tokenId}/authority",
      pathFields: [tokenIdField],
      bodyFields: [
        {
          key: "authority.role",
          label: "authority.role",
          placeholder: t("DashboardIssuance.playground.selectAuthorityRole"),
          kind: "select",
          options: authorityRoleOptions,
          defaultValue: authorityRoleOptions[0]?.value ?? "mint",
          required: true,
        },
        {
          key: "authority.currentAuthority",
          label: "authority.currentAuthority",
          placeholder: t("DashboardIssuance.playground.currentAuthorityAddress"),
        },
        {
          key: "authority.newAuthority",
          label: "authority.newAuthority",
          placeholder: t("DashboardIssuance.playground.newAuthorityAddress"),
        },
        ...buildPriorityFields(t),
      ],
      expectedResponse: {
        data: {
          transaction: {
            id: "tx_authority_live_123",
            tokenId: exampleTokenId,
            type: "authority_update",
            status: "processing",
          },
        },
      },
    },
    {
      id: "pause-token",
      title: t("DashboardIssuance.playground.pauseToken"),
      method: "POST",
      path: "/v1/issuance/tokens/{tokenId}/pause",
      pathFields: [tokenIdField],
      bodyFields: buildPriorityFields(t),
      expectedResponse: {
        data: {
          token: {
            id: exampleTokenId,
            status: "paused",
          },
        },
      },
    },
    {
      id: "unpause-token",
      title: t("DashboardIssuance.playground.unpauseToken"),
      method: "POST",
      path: "/v1/issuance/tokens/{tokenId}/unpause",
      pathFields: [tokenIdField],
      bodyFields: buildPriorityFields(t),
      expectedResponse: {
        data: {
          token: {
            id: exampleTokenId,
            status: "active",
          },
        },
      },
    },
    {
      id: "freeze-account",
      title: t("DashboardIssuance.playground.freezeAccount"),
      method: "POST",
      path: "/v1/issuance/tokens/{tokenId}/freeze",
      pathFields: [tokenIdField],
      bodyFields: [
        {
          key: "accountAddress",
          label: "accountAddress",
          placeholder: t("DashboardIssuance.playground.walletAddressToFreeze"),
          required: true,
        },
        {
          key: "reason",
          label: "reason",
          placeholder: t("DashboardIssuance.playground.optionalFreezeReason"),
        },
      ],
      expectedResponse: {
        data: {
          accountAddress: exampleWalletAddress,
          status: "frozen",
        },
      },
    },
    {
      id: "unfreeze-account",
      title: t("DashboardIssuance.playground.unfreezeAccount"),
      method: "POST",
      path: "/v1/issuance/tokens/{tokenId}/unfreeze",
      pathFields: [tokenIdField],
      bodyFields: [
        {
          key: "accountAddress",
          label: "accountAddress",
          placeholder: t("DashboardIssuance.playground.walletAddressToUnfreeze"),
          required: true,
        },
      ],
      expectedResponse: {
        data: {
          accountAddress: exampleWalletAddress,
          status: "active",
        },
      },
    },
    {
      id: "list-frozen-accounts",
      title: t("DashboardIssuance.playground.listFrozenAccounts"),
      method: "GET",
      path: "/v1/issuance/tokens/{tokenId}/frozen",
      pathFields: [tokenIdField],
      bodyFields: [],
      expectedResponse: {
        data: {
          accounts: [
            {
              address: exampleTokenAccountAddress,
              frozenAt: "2026-03-06T12:00:00.000Z",
            },
          ],
        },
      },
    },
    {
      id: "list-allowlist",
      title: t("DashboardIssuance.playground.listAllowlist"),
      method: "GET",
      path: "/v1/issuance/tokens/{tokenId}/allowlist",
      pathFields: [tokenIdField],
      bodyFields: [],
      expectedResponse: {
        data: {
          items: [
            {
              id: "allow_123",
              address: exampleTokenAccountAddress,
              label: t("DashboardIssuance.playground.treasuryExample"),
            },
          ],
        },
      },
    },
    {
      id: "add-allowlist-entry",
      title: t("DashboardIssuance.playground.addAllowlistEntry"),
      method: "POST",
      path: "/v1/issuance/tokens/{tokenId}/allowlist",
      pathFields: [tokenIdField],
      bodyFields: [
        {
          key: "address",
          label: "address",
          placeholder: t("DashboardIssuance.playground.addressToAllowlist"),
          required: true,
        },
        {
          key: "label",
          label: "label",
          placeholder: t("DashboardIssuance.playground.optionalLabel"),
        },
      ],
      expectedResponse: {
        data: {
          entry: {
            id: "allow_123",
            address: exampleTokenAccountAddress,
            label: t("DashboardIssuance.playground.treasuryExample"),
          },
        },
      },
    },
    {
      id: "remove-allowlist-entry",
      title: t("DashboardIssuance.playground.removeAllowlistEntry"),
      method: "DELETE",
      path: "/v1/issuance/tokens/{tokenId}/allowlist/{entryId}",
      pathFields: [
        tokenIdField,
        {
          key: "entryId",
          label: "entryId",
          placeholder: t("DashboardIssuance.playground.allowlistEntryIdPlaceholder"),
          required: true,
        },
      ],
      bodyFields: [],
      expectedResponse: {
        data: {
          deleted: true,
          entryId: "allow_123",
        },
      },
    },
  ];
}
