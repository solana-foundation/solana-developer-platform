import type { KnownCustodyProvider } from "@/app/dashboard/custody/provider-catalog";
import { formatCustodyProviderName } from "@/app/dashboard/custody/provider-catalog";
import type {
  ApiPlaygroundEndpointConfig,
  ApiPlaygroundFieldConfig,
  ApiPlaygroundFieldOption,
} from "@/components/api-playground-shell";

export interface WalletsPlaygroundWalletView {
  walletId: string;
  label: string | null;
  provider: string | null;
  publicKey: string;
}

interface BuildWalletsPlaygroundConfigOptions {
  connectedProviders: KnownCustodyProvider[];
  wallets: WalletsPlaygroundWalletView[];
}

const PURPOSE_OPTIONS: ApiPlaygroundFieldOption[] = [
  { label: "Root wallet", value: "root" },
  { label: "Mint authority", value: "mint_authority" },
  { label: "Freeze authority", value: "freeze_authority" },
  { label: "Fee payer", value: "fee_payer" },
  { label: "Transfers", value: "transfer" },
];

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
}: BuildWalletsPlaygroundConfigOptions): ApiPlaygroundEndpointConfig[] {
  const walletOptions = buildWalletOptions(wallets);
  const providerOptions = buildProviderOptions(connectedProviders);
  const firstWallet = wallets[0];
  const exampleWalletId = firstWallet?.walletId ?? "privy_wallet_123";
  const exampleWalletLabel = firstWallet?.label?.trim() || "Main wallet";
  // biome-ignore lint/security/noSecrets: Playground sample public key for example responses only.
  const examplePublicKey = firstWallet?.publicKey ?? "11111111111111111111111111111111";

  return [
    {
      id: "list-wallets",
      title: "List Wallets",
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
      title: "List Wallet Configs",
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
      title: "Get Wallet",
      method: "GET",
      path: "/v1/wallets/{walletId}",
      pathFields: [buildSelectOrTextField("walletId", "{walletId}", "Wallet ID", walletOptions)],
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
      title: "Get Wallet Public Key",
      method: "GET",
      // biome-ignore lint/security/noSecrets: Public API path with a documented query parameter.
      path: "/v1/wallets/public-key?walletId={walletId}",
      pathFields: [buildSelectOrTextField("walletId", "walletId", "Wallet ID", walletOptions)],
      bodyFields: [],
      expectedResponse: {
        data: {
          publicKey: examplePublicKey,
        },
      },
    },
    {
      id: "aggregate-balances",
      title: "Aggregate Wallet Balances",
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
      title: "Create Wallet",
      method: "POST",
      path: "/v1/wallets",
      pathFields: [],
      bodyFields: [
        buildSelectOrTextField("provider", "provider", "Provider", providerOptions),
        {
          key: "label",
          label: "label",
          placeholder: "Main settlement wallet",
          defaultValue: exampleWalletLabel,
          required: true,
        },
        {
          key: "purpose",
          label: "purpose",
          placeholder: "Select wallet purpose",
          kind: "select",
          options: PURPOSE_OPTIONS,
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
      title: "Signer Check",
      method: "POST",
      path: "/v1/wallets/signer-check",
      pathFields: [],
      bodyFields: [
        buildSelectOrTextField("walletId", "walletId", "Wallet ID", walletOptions),
        {
          key: "memo",
          label: "memo",
          placeholder: "Ownership proof from the wallet playground",
          defaultValue: "Ownership proof from the wallet playground",
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
