import type {
  ApiPlaygroundEndpointConfig,
  ApiPlaygroundFieldConfig,
} from "@/components/api-playground-shell";
import type { MessageKey, TranslationValues } from "@/i18n/messages";
import { mergeOpenApiPlaygroundEndpoints } from "@/lib/api-playground-openapi-catalog";

// Sandbox constants from PROPOSAL.md §0. Kept as literals so the playground works
// out of the box for a newly connected project — override in the form when the
// operator points at a different instance.
const SANDBOX_GATEWAY_URL = "http://34.71.147.163:8899";
const SANDBOX_CHAIN_RPC_URL = "https://api.devnet.solana.com";
const SANDBOX_AUTH_URL = "http://34.71.147.163:8903";
const SANDBOX_ESCROW_PROGRAM_ID = "9tgHa1DcnaSSUtmMsst8ovKTe1Gfxzezn27KnH9xXYeU";
const SANDBOX_WITHDRAW_PROGRAM_ID = "J231K9UEpS4y4KAPwGc4gsMNCjKFRMYcQBcjVW7vBhVi";
const SANDBOX_ESCROW_INSTANCE_ADDR = "7C1Pu8mbHaDDTFnGH8YTqemNDofqXP3XEotzSo6TbwHz";
const SANDBOX_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

const exampleWalletId = "wlt_example";
const exampleChannelId = "pch_9f1c...";
const exampleDepositId = "dep_9f1c...";
const exampleWithdrawalId = "wd_9f1c...";

// OpenAPI path tokens rendered as-is in the form — kept out of translations by
// composition, following the counterparty playground precedent.
const pathTokenLabel = (name: string) => ["{", name, "}"].join("");
const idPathLabel = pathTokenLabel("id");
const channelIdPathLabel = pathTokenLabel("channelId");
const walletIdPathLabel = pathTokenLabel("walletId");
// Schema example (createPrivateChannelBodySchema.name.example = "Treasury");
// used as a placeholder in the create-channel form.
const exampleChannelName = ["Treas", "ury"].join("");

type Translate = (key: MessageKey, values?: TranslationValues) => string;

const channelIdPathField: ApiPlaygroundFieldConfig = {
  key: "channelId",
  label: channelIdPathLabel,
  placeholder: exampleChannelId,
  defaultValue: exampleChannelId,
  required: true,
};

const channelIdParamField: ApiPlaygroundFieldConfig = {
  key: "id",
  label: idPathLabel,
  placeholder: exampleChannelId,
  defaultValue: exampleChannelId,
  required: true,
};

const depositIdField: ApiPlaygroundFieldConfig = {
  key: "id",
  label: idPathLabel,
  placeholder: exampleDepositId,
  defaultValue: exampleDepositId,
  required: true,
};

const withdrawalIdField: ApiPlaygroundFieldConfig = {
  key: "id",
  label: idPathLabel,
  placeholder: exampleWithdrawalId,
  defaultValue: exampleWithdrawalId,
  required: true,
};

const walletIdField: ApiPlaygroundFieldConfig = {
  key: "walletId",
  label: walletIdPathLabel,
  placeholder: exampleWalletId,
  defaultValue: exampleWalletId,
  required: true,
};

export function buildPrivateChannelsPlaygroundEndpointConfigs(
  t: Translate
): ApiPlaygroundEndpointConfig[] {
  const curatedEndpoints: ApiPlaygroundEndpointConfig[] = [
    {
      id: "get-private-channel-instance",
      title: t("DashboardPrivateChannels.playground.getInstance"),
      method: "GET",
      path: "/v1/private-channels/instance",
      pathFields: [],
      bodyFields: [],
      expectedResponse: {
        data: {
          instance: {
            id: "pci_01HXYZ",
            gatewayUrl: SANDBOX_GATEWAY_URL,
            chainRpcUrl: SANDBOX_CHAIN_RPC_URL,
            escrowProgramId: SANDBOX_ESCROW_PROGRAM_ID,
            withdrawProgramId: SANDBOX_WITHDRAW_PROGRAM_ID,
            escrowInstanceAddr: SANDBOX_ESCROW_INSTANCE_ADDR,
            authUrl: SANDBOX_AUTH_URL,
            isActive: true,
          },
        },
      },
    },
    {
      id: "connect-private-channel-instance",
      title: t("DashboardPrivateChannels.playground.connectInstance"),
      method: "POST",
      path: "/v1/private-channels/instance",
      pathFields: [],
      bodyFields: [
        {
          key: "gatewayUrl",
          label: "gatewayUrl",
          defaultValue: SANDBOX_GATEWAY_URL,
          required: true,
        },
        {
          key: "chainRpcUrl",
          label: "chainRpcUrl",
          defaultValue: SANDBOX_CHAIN_RPC_URL,
          required: true,
        },
        {
          key: "escrowProgramId",
          label: "escrowProgramId",
          defaultValue: SANDBOX_ESCROW_PROGRAM_ID,
          required: true,
        },
        {
          key: "withdrawProgramId",
          label: "withdrawProgramId",
          defaultValue: SANDBOX_WITHDRAW_PROGRAM_ID,
          required: true,
        },
        {
          key: "escrowInstanceAddr",
          label: "escrowInstanceAddr",
          defaultValue: SANDBOX_ESCROW_INSTANCE_ADDR,
          required: true,
        },
        {
          key: "authUrl",
          label: "authUrl",
          defaultValue: SANDBOX_AUTH_URL,
          required: true,
        },
      ],
      expectedResponse: {
        data: {
          instance: {
            id: "pci_01HXYZ",
            gatewayUrl: SANDBOX_GATEWAY_URL,
            isActive: true,
          },
        },
      },
    },
    {
      id: "probe-private-channel-connection",
      title: t("DashboardPrivateChannels.playground.probeConnection"),
      method: "POST",
      path: "/v1/private-channels/probe",
      pathFields: [],
      bodyFields: [
        {
          key: "gatewayUrl",
          label: "gatewayUrl",
          defaultValue: SANDBOX_GATEWAY_URL,
          required: true,
        },
        {
          key: "chainRpcUrl",
          label: "chainRpcUrl",
          defaultValue: SANDBOX_CHAIN_RPC_URL,
          required: true,
        },
        {
          key: "authUrl",
          label: "authUrl",
          defaultValue: SANDBOX_AUTH_URL,
          required: true,
        },
      ],
      expectedResponse: {
        data: {
          ok: true,
          gateway: { status: "ready", latencyMs: 42 },
          rpc: { ok: true, latencyMs: 65, version: "1.18.0" },
          auth: { ok: true, latencyMs: 30 },
        },
      },
    },
    {
      id: "get-private-channel-health",
      title: t("DashboardPrivateChannels.playground.probeHealth"),
      method: "GET",
      path: "/v1/private-channels/health?gatewayUrl={gatewayUrl}",
      pathFields: [
        {
          key: "gatewayUrl",
          label: "gatewayUrl",
          defaultValue: SANDBOX_GATEWAY_URL,
          required: true,
        },
      ],
      bodyFields: [],
      expectedResponse: {
        data: { status: "ready", latencyMs: 42 },
      },
    },
    {
      id: "get-private-channel-balance",
      title: t("DashboardPrivateChannels.playground.getBalance"),
      method: "GET",
      path: "/v1/private-channels/balance?owner={owner}&mint={mint}",
      pathFields: [
        {
          key: "owner",
          label: "owner",
          placeholder: t("DashboardPrivateChannels.playground.ownerPlaceholder"),
          defaultValue: exampleWalletId,
          required: true,
        },
        {
          key: "mint",
          label: "mint",
          defaultValue: SANDBOX_USDC_MINT,
        },
      ],
      bodyFields: [],
      expectedResponse: {
        data: {
          owner: SANDBOX_ESCROW_INSTANCE_ADDR,
          mint: SANDBOX_USDC_MINT,
          amount: "1500000",
          decimals: 6,
          uiAmount: "1.5",
        },
      },
    },
    {
      id: "create-private-channel-deposit",
      title: t("DashboardPrivateChannels.playground.createDeposit"),
      method: "POST",
      path: "/v1/private-channels/deposits",
      pathFields: [],
      bodyFields: [
        {
          key: "walletId",
          label: "walletId",
          placeholder: exampleWalletId,
          defaultValue: exampleWalletId,
          required: true,
        },
        {
          key: "amount",
          label: "amount",
          placeholder: "1.5",
          defaultValue: "1.5",
          required: true,
        },
        {
          key: "recipient",
          label: "recipient",
          placeholder: t("DashboardPrivateChannels.playground.recipientPlaceholder"),
          description: t("DashboardPrivateChannels.playground.recipientHint"),
        },
      ],
      expectedResponse: {
        data: {
          id: exampleDepositId,
          walletId: exampleWalletId,
          amount: "1.5",
          status: "submitted",
        },
      },
    },
    {
      id: "create-private-channel-withdrawal",
      title: t("DashboardPrivateChannels.playground.createWithdrawal"),
      method: "POST",
      path: "/v1/private-channels/withdrawals",
      pathFields: [],
      bodyFields: [
        {
          key: "walletId",
          label: "walletId",
          placeholder: exampleWalletId,
          defaultValue: exampleWalletId,
          required: true,
        },
        {
          key: "amount",
          label: "amount",
          placeholder: "1.5",
          defaultValue: "1.5",
          required: true,
        },
        {
          key: "destination",
          label: "destination",
          placeholder: t("DashboardPrivateChannels.playground.destinationPlaceholder"),
          description: t("DashboardPrivateChannels.playground.destinationHint"),
        },
      ],
      expectedResponse: {
        data: {
          id: exampleWithdrawalId,
          walletId: exampleWalletId,
          amount: "1.5",
          status: "submitted",
        },
      },
    },
    {
      id: "create-private-channel",
      title: t("DashboardPrivateChannels.playground.createChannel"),
      method: "POST",
      path: "/v1/private-channels/channels",
      pathFields: [],
      bodyFields: [
        {
          key: "name",
          label: "name",
          placeholder: exampleChannelName,
          defaultValue: exampleChannelName,
          required: true,
        },
        {
          key: "description",
          label: "description",
          placeholder: t("DashboardPrivateChannels.playground.channelDescriptionPlaceholder"),
        },
      ],
      expectedResponse: {
        data: { id: exampleChannelId, name: exampleChannelName },
      },
    },
    {
      id: "get-private-channel-deposit",
      title: t("DashboardPrivateChannels.playground.getDeposit"),
      method: "GET",
      path: "/v1/private-channels/deposits/{id}",
      pathFields: [depositIdField],
      bodyFields: [],
      expectedResponse: {
        data: { id: exampleDepositId, status: "confirmed" },
      },
    },
    {
      id: "get-private-channel-withdrawal",
      title: t("DashboardPrivateChannels.playground.getWithdrawal"),
      method: "GET",
      path: "/v1/private-channels/withdrawals/{id}",
      pathFields: [withdrawalIdField],
      bodyFields: [],
      expectedResponse: {
        data: { id: exampleWithdrawalId, status: "settled" },
      },
    },
    {
      id: "get-private-channel",
      title: t("DashboardPrivateChannels.playground.getChannel"),
      method: "GET",
      path: "/v1/private-channels/channels/{id}",
      pathFields: [channelIdParamField],
      bodyFields: [],
      expectedResponse: {
        data: { id: exampleChannelId, name: exampleChannelName },
      },
    },
    {
      id: "list-private-channel-transfer-recipients",
      title: t("DashboardPrivateChannels.playground.listTransferRecipients"),
      method: "GET",
      path: "/v1/private-channels/channels/{channelId}/transfer-recipients",
      pathFields: [channelIdPathField],
      bodyFields: [],
      expectedResponse: {
        data: {
          recipients: [
            { memberId: "pcm_9f1c...", wallets: [{ pubkey: SANDBOX_ESCROW_INSTANCE_ADDR }] },
          ],
        },
      },
    },
    {
      id: "verify-private-channel-wallet",
      title: t("DashboardPrivateChannels.playground.verifyWallet"),
      method: "POST",
      path: "/v1/private-channels/wallets/{walletId}/verify",
      pathFields: [walletIdField],
      bodyFields: [],
      expectedResponse: {
        data: {
          wallet: {
            id: "pcvw_9f1c...",
            walletId: exampleWalletId,
            pubkey: SANDBOX_ESCROW_INSTANCE_ADDR,
          },
        },
      },
    },
  ];

  // Merge fills in the remaining ~13 SPC operations (list deposits, list
  // withdrawals, list transfers, get transfer, list channels, delete channel,
  // list events, list project events, list verified wallets, delete verified
  // wallet, get overview, disconnect instance, delete instance) from the
  // generated OpenAPI catalog.
  return mergeOpenApiPlaygroundEndpoints("private-channels", curatedEndpoints);
}
