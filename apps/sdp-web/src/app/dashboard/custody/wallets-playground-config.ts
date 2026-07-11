import type { KnownCustodyProvider } from "@/app/dashboard/custody/provider-catalog";
import { formatCustodyProviderName } from "@/app/dashboard/custody/provider-catalog";
import type {
  ApiPlaygroundEndpointConfig,
  ApiPlaygroundFieldConfig,
  ApiPlaygroundFieldOption,
} from "@/components/api-playground-shell";
import type { useTranslations } from "@/i18n/provider";

export interface WalletsPlaygroundWalletView {
  walletId: string;
  label: string | null;
  provider: string | null;
  publicKey: string;
}

interface BuildWalletsPlaygroundConfigOptions {
  connectedProviders: KnownCustodyProvider[];
  wallets: WalletsPlaygroundWalletView[];
  t: ReturnType<typeof useTranslations>;
}

function buildPurposeOptions(t: ReturnType<typeof useTranslations>): ApiPlaygroundFieldOption[] {
  return [
    { label: t("DashboardCustody.rootWallet"), value: "root" },
    { label: t("DashboardCustody.mintAuthority"), value: "mint_authority" },
    { label: t("DashboardCustody.freezeAuthority"), value: "freeze_authority" },
    { label: t("DashboardCustody.feePayer"), value: "fee_payer" },
    { label: t("DashboardCustody.transfers"), value: "transfer" },
  ];
}

function buildWalletOptions(wallets: WalletsPlaygroundWalletView[]): ApiPlaygroundFieldOption[] {
  return wallets.map((wallet) => ({
    value: wallet.walletId,
    label: wallet.label?.trim() ? `${wallet.label} (${wallet.walletId})` : wallet.walletId,
  }));
}

function buildProviderOptions(providers: KnownCustodyProvider[]): ApiPlaygroundFieldOption[] {
  return providers.map((provider) => ({
    value: provider,
    label: formatCustodyProviderName(provider),
  }));
}

function buildSelectOrTextField(
  key: string,
  label: string,
  placeholder: string,
  options: ApiPlaygroundFieldOption[],
  required = true
): ApiPlaygroundFieldConfig {
  if (options.length === 0) {
    return { key, label, placeholder, required };
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

export function buildWalletsPlaygroundEndpointConfigs({
  connectedProviders,
  wallets,
  t,
}: BuildWalletsPlaygroundConfigOptions): ApiPlaygroundEndpointConfig[] {
  const walletOptions = buildWalletOptions(wallets);
  const providerOptions = buildProviderOptions(connectedProviders);
  const firstWallet = wallets[0];
  const exampleWalletId = firstWallet?.walletId ?? "privy_wallet_123";
  const exampleWalletLabel = firstWallet?.label?.trim() || t("DashboardCustody.mainWallet");
  // biome-ignore lint/security/noSecrets: Playground sample public key for example responses only.
  const examplePublicKey = firstWallet?.publicKey ?? "11111111111111111111111111111111";

  return [
    {
      id: "list-wallets",
      title: t("DashboardCustody.playgroundListWallets"),
      method: "GET",
      // biome-ignore lint/security/noSecrets: Public API path with static query flags.
      path: "/v1/wallets?includeAllProviders=true",
      pathFields: [],
      bodyFields: [],
      expectedResponse: {
        data: {
          wallets:
            wallets.length > 0
              ? wallets.map((wallet) => ({
                  walletId: wallet.walletId,
                  label: wallet.label,
                  provider: wallet.provider,
                  publicKey: wallet.publicKey,
                }))
              : [
                  {
                    walletId: exampleWalletId,
                    label: exampleWalletLabel,
                    provider: "privy",
                    publicKey: examplePublicKey,
                  },
                ],
        },
      },
    },
    {
      id: "list-wallet-configs",
      title: t("DashboardCustody.playgroundListWalletConfigs"),
      method: "GET",
      path: "/v1/wallets/configs",
      pathFields: [],
      bodyFields: [],
      expectedResponse: {
        data: {
          configs:
            connectedProviders.length > 0
              ? connectedProviders.map((provider) => ({
                  provider,
                  status: "active",
                }))
              : [{ provider: "privy", status: "active" }],
        },
      },
    },
    {
      id: "get-wallet",
      title: t("DashboardCustody.playgroundGetWallet"),
      method: "GET",
      path: "/v1/wallets/{walletId}",
      pathFields: [
        buildSelectOrTextField(
          "walletId",
          "{walletId}",
          t("DashboardCustody.walletId"),
          walletOptions
        ),
      ],
      bodyFields: [],
      expectedResponse: {
        data: {
          wallet: {
            walletId: exampleWalletId,
            label: exampleWalletLabel,
            publicKey: examplePublicKey,
          },
        },
      },
    },
    {
      id: "get-wallet-public-key",
      title: t("DashboardCustody.playgroundGetWalletPublicKey"),
      method: "GET",
      // biome-ignore lint/security/noSecrets: Public API path with a documented query parameter.
      path: "/v1/wallets/public-key?walletId={walletId}",
      pathFields: [
        buildSelectOrTextField(
          "walletId",
          "walletId",
          t("DashboardCustody.walletId"),
          walletOptions
        ),
      ],
      bodyFields: [],
      expectedResponse: {
        data: {
          publicKey: examplePublicKey,
        },
      },
    },
    {
      id: "aggregate-balances",
      title: t("DashboardCustody.playgroundAggregateBalances"),
      method: "GET",
      // biome-ignore lint/security/noSecrets: Public API path with static query flags.
      path: "/v1/wallets/aggregate?includeAllProviders=true",
      pathFields: [],
      bodyFields: [],
      expectedResponse: {
        data: {
          aggregate: {
            walletCount: wallets.length || 1,
            balances: [
              { token: "SOL", uiAmount: "12.34" },
              { token: "USDC", uiAmount: "2500.00" },
            ],
          },
        },
      },
    },
    {
      id: "create-wallet",
      title: t("DashboardCustody.playgroundCreateWallet"),
      method: "POST",
      path: "/v1/wallets",
      pathFields: [],
      bodyFields: [
        buildSelectOrTextField(
          "provider",
          t("DashboardCustody.playgroundProviderField"),
          t("DashboardCustody.rpcProvider"),
          providerOptions
        ),
        {
          key: "label",
          label: t("DashboardCustody.playgroundLabelField"),
          placeholder: t("DashboardCustody.mainSettlementWallet"),
          defaultValue: exampleWalletLabel,
          required: true,
        },
        {
          key: "purpose",
          label: t("DashboardCustody.playgroundPurposeField"),
          placeholder: t("DashboardCustody.selectWalletPurpose"),
          kind: "select",
          options: buildPurposeOptions(t),
          defaultValue: "root",
        },
      ],
      expectedResponse: {
        data: {
          wallet: {
            walletId: exampleWalletId,
            label: exampleWalletLabel,
            provider: connectedProviders[0] ?? "privy",
            publicKey: examplePublicKey,
          },
        },
      },
    },
    {
      id: "signer-check",
      title: t("DashboardCustody.playgroundSignerCheck"),
      method: "POST",
      path: "/v1/wallets/signer-check",
      pathFields: [],
      bodyFields: [
        buildSelectOrTextField(
          "walletId",
          "walletId",
          t("DashboardCustody.walletId"),
          walletOptions
        ),
        {
          key: "memo",
          label: t("DashboardCustody.playgroundMemoField"),
          placeholder: t("DashboardCustody.ownershipProof"),
          defaultValue: t("DashboardCustody.ownershipProof"),
        },
      ],
      expectedResponse: {
        data: {
          transaction: {
            // biome-ignore lint/security/noSecrets: Example signature for playground response preview.
            signature: "5n2ExampleSignature",
          },
        },
      },
    },
  ];
}
