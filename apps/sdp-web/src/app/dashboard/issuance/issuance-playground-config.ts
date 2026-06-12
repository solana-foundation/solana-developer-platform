import type {
  ApiPlaygroundEndpointConfig,
  ApiPlaygroundFieldConfig,
  ApiPlaygroundFieldOption,
} from "@/components/api-playground-shell";
import { TOKEN_AMOUNT_FIELD_DESCRIPTION } from "./[tokenId]/token-management-workspace.utils";

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
}

const priorityFeeOptions: ApiPlaygroundFieldOption[] = [
  { label: "None", value: "none" },
  { label: "Low", value: "low" },
  { label: "Medium", value: "medium" },
  { label: "High", value: "high" },
];

const simulateOptions: ApiPlaygroundFieldOption[] = [
  { label: "True", value: "true" },
  { label: "False", value: "false" },
];

const tokenStatusOptions: ApiPlaygroundFieldOption[] = [
  { label: "Active", value: "active" },
  { label: "Paused", value: "paused" },
];

const authorityRoleOptions: ApiPlaygroundFieldOption[] = [
  { label: "Mint", value: "mint" },
  { label: "Freeze", value: "freeze" },
  { label: "Permanent Delegate", value: "permanentDelegate" },
  { label: "Metadata", value: "metadata" },
];

const exampleTokenAccountAddress = "1".repeat(32);
const exampleWalletAddress = "2".repeat(32);

function buildTokenAmountField(
  key: string,
  label: string,
  defaultValue = "1000"
): ApiPlaygroundFieldConfig {
  return {
    key,
    label,
    defaultValue,
    placeholder: "e.g. 1000",
    description: TOKEN_AMOUNT_FIELD_DESCRIPTION,
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

function buildPriorityFields(): ApiPlaygroundFieldConfig[] {
  return [
    {
      key: "options.priorityFee",
      label: "options.priorityFee",
      placeholder: "Select options priorityFee",
      kind: "select",
      options: priorityFeeOptions,
    },
    {
      key: "options.simulate",
      label: "options.simulate",
      placeholder: "Select options simulate",
      kind: "select",
      options: simulateOptions,
      valueType: "boolean",
    },
  ];
}

export function buildIssuancePlaygroundEndpointConfigs({
  templates,
  tokens,
}: BuildIssuancePlaygroundConfigOptions): ApiPlaygroundEndpointConfig[] {
  const tokenOptions = buildTokenOptions(tokens);
  const templateOptions = buildTemplateOptions(templates);
  const firstToken = tokens[0];
  const firstTemplate = templates[0];
  const tokenIdField = buildSelectBackedField(
    "tokenId",
    "{tokenId}",
    "Token ID (e.g. tok_abc123)",
    tokenOptions
  );
  const templateIdField = buildSelectBackedField(
    "templateId",
    "{templateId}",
    "Template ID (e.g. stablecoin)",
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
      title: "List Templates",
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
      title: "Get Template",
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
      title: "Create Token",
      method: "POST",
      path: "/v1/issuance/tokens",
      pathFields: [],
      bodyFields: [
        {
          key: "name",
          label: "name",
          placeholder: "Acme Dollar",
          defaultValue: exampleTokenName,
          required: true,
        },
        {
          key: "symbol",
          label: "symbol",
          placeholder: "ACME",
          defaultValue: exampleTokenSymbol,
          required: true,
        },
        {
          key: "template",
          label: "template",
          placeholder: "Select template",
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
          placeholder: "USD-backed settlement asset",
          defaultValue: "USD-backed settlement asset",
        },
        {
          key: "uri",
          label: "uri",
          placeholder: "https://example.com/metadata/acme-usd.json",
          defaultValue: "https://example.com/metadata/acme-usd.json",
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
      title: "List Tokens",
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
      title: "Get Token",
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
      title: "Update Token",
      method: "PATCH",
      path: "/v1/issuance/tokens/{tokenId}",
      pathFields: [tokenIdField],
      bodyFields: [
        {
          key: "name",
          label: "name",
          placeholder: "Updated token name",
        },
        {
          key: "description",
          label: "description",
          placeholder: "Updated token description",
        },
        {
          key: "uri",
          label: "uri",
          placeholder: "https://example.com/updated-metadata.json",
        },
        {
          key: "imageUrl",
          label: "imageUrl",
          placeholder: "https://example.com/token.png",
        },
        {
          key: "status",
          label: "status",
          placeholder: "Select status",
          kind: "select",
          options: tokenStatusOptions,
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
      title: "List Token Transactions",
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
      title: "Refresh Total Supply",
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
      title: "Deploy Token",
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
      title: "Mint Tokens",
      method: "POST",
      path: "/v1/issuance/tokens/{tokenId}/mint",
      pathFields: [tokenIdField],
      bodyFields: [
        {
          key: "mint.destination",
          label: "mint.destination",
          placeholder: "Solana address (32-44 chars)",
          required: true,
        },
        buildTokenAmountField("mint.amount", "mint.amount"),
        {
          key: "mint.memo",
          label: "mint.memo",
          placeholder: "Optional memo",
        },
        ...buildPriorityFields(),
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
      title: "Burn Tokens",
      method: "POST",
      path: "/v1/issuance/tokens/{tokenId}/burn",
      pathFields: [tokenIdField],
      bodyFields: [
        {
          key: "burn.source",
          label: "burn.source",
          placeholder: "Token account address (32-44 chars)",
          required: true,
        },
        buildTokenAmountField("burn.amount", "burn.amount"),
        {
          key: "burn.memo",
          label: "burn.memo",
          placeholder: "Optional memo",
        },
        ...buildPriorityFields(),
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
      title: "Seize Tokens",
      method: "POST",
      path: "/v1/issuance/tokens/{tokenId}/seize",
      pathFields: [tokenIdField],
      bodyFields: [
        {
          key: "seize.source",
          label: "seize.source",
          placeholder: "Source token account address",
          required: true,
        },
        {
          key: "seize.destination",
          label: "seize.destination",
          placeholder: "Destination token account address",
          required: true,
        },
        buildTokenAmountField("seize.amount", "seize.amount", "250"),
        {
          key: "seize.delegateAuthority",
          label: "seize.delegateAuthority",
          placeholder: "Delegate authority address",
        },
        {
          key: "seize.memo",
          label: "seize.memo",
          placeholder: "Optional memo",
        },
        ...buildPriorityFields(),
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
      title: "Force Burn",
      method: "POST",
      path: "/v1/issuance/tokens/{tokenId}/force-burn",
      pathFields: [tokenIdField],
      bodyFields: [
        {
          key: "forceBurn.source",
          label: "forceBurn.source",
          placeholder: "Token account address",
          required: true,
        },
        buildTokenAmountField("forceBurn.amount", "forceBurn.amount", "250"),
        {
          key: "forceBurn.delegateAuthority",
          label: "forceBurn.delegateAuthority",
          placeholder: "Delegate authority address",
        },
        {
          key: "forceBurn.memo",
          label: "forceBurn.memo",
          placeholder: "Optional memo",
        },
        ...buildPriorityFields(),
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
      title: "Update Authority",
      method: "POST",
      path: "/v1/issuance/tokens/{tokenId}/authority",
      pathFields: [tokenIdField],
      bodyFields: [
        {
          key: "authority.role",
          label: "authority.role",
          placeholder: "Select authority role",
          kind: "select",
          options: authorityRoleOptions,
          defaultValue: authorityRoleOptions[0]?.value ?? "mint",
          required: true,
        },
        {
          key: "authority.currentAuthority",
          label: "authority.currentAuthority",
          placeholder: "Current authority address",
        },
        {
          key: "authority.newAuthority",
          label: "authority.newAuthority",
          placeholder: "New authority address",
        },
        ...buildPriorityFields(),
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
      title: "Pause Token",
      method: "POST",
      path: "/v1/issuance/tokens/{tokenId}/pause",
      pathFields: [tokenIdField],
      bodyFields: buildPriorityFields(),
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
      title: "Unpause Token",
      method: "POST",
      path: "/v1/issuance/tokens/{tokenId}/unpause",
      pathFields: [tokenIdField],
      bodyFields: buildPriorityFields(),
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
      title: "Freeze Account",
      method: "POST",
      path: "/v1/issuance/tokens/{tokenId}/freeze",
      pathFields: [tokenIdField],
      bodyFields: [
        {
          key: "accountAddress",
          label: "accountAddress",
          placeholder: "Wallet address to freeze",
          required: true,
        },
        {
          key: "reason",
          label: "reason",
          placeholder: "Optional freeze reason",
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
      title: "Unfreeze Account",
      method: "POST",
      path: "/v1/issuance/tokens/{tokenId}/unfreeze",
      pathFields: [tokenIdField],
      bodyFields: [
        {
          key: "accountAddress",
          label: "accountAddress",
          placeholder: "Wallet address to unfreeze",
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
      title: "List Frozen Accounts",
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
      title: "List Allowlist",
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
              label: "Treasury",
            },
          ],
        },
      },
    },
    {
      id: "add-allowlist-entry",
      title: "Add Allowlist Entry",
      method: "POST",
      path: "/v1/issuance/tokens/{tokenId}/allowlist",
      pathFields: [tokenIdField],
      bodyFields: [
        {
          key: "address",
          label: "address",
          placeholder: "Address to allowlist",
          required: true,
        },
        {
          key: "label",
          label: "label",
          placeholder: "Optional label",
        },
      ],
      expectedResponse: {
        data: {
          entry: {
            id: "allow_123",
            address: exampleTokenAccountAddress,
            label: "Treasury",
          },
        },
      },
    },
    {
      id: "remove-allowlist-entry",
      title: "Remove Allowlist Entry",
      method: "DELETE",
      path: "/v1/issuance/tokens/{tokenId}/allowlist/{entryId}",
      pathFields: [
        tokenIdField,
        {
          key: "entryId",
          label: "{entryId}",
          placeholder: "Allowlist entry ID (e.g. allow_123)",
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
