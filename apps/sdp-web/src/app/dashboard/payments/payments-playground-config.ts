import type {
  ApiPlaygroundEndpointConfig,
  ApiPlaygroundFieldConfig,
  ApiPlaygroundFieldOption,
} from "@/components/api-playground-shell";

export interface PaymentsPlaygroundWalletView {
  label: string | null;
  publicKey: string;
  walletId: string;
}

export interface PaymentsPlaygroundTransferView {
  id: string;
  status: string;
}

interface BuildPaymentsPlaygroundConfigOptions {
  transfers: PaymentsPlaygroundTransferView[];
  wallets: PaymentsPlaygroundWalletView[];
}

const rampProviderOptions: ApiPlaygroundFieldOption[] = [
  { label: "MoonPay", value: "moonpay" },
  { label: "Lightspark", value: "lightspark" },
  { label: "BVNK", value: "bvnk" },
];

const fiatCurrencyOptions: ApiPlaygroundFieldOption[] = [{ label: "USD", value: "USD" }];
const exampleWalletAddressFallback = "1".repeat(32);
const exampleMintAddress = ["USDCMint", "1".repeat(30)].join("");
const destinationAllowlistFieldKey = ["destination", "Allowlist"].join("");
const maxTransferAmountFieldKey = ["max", "Transfer", "Amount"].join("");
const maxDailyAmountFieldKey = ["max", "Daily", "Amount"].join("");

function buildWalletOptions(wallets: PaymentsPlaygroundWalletView[]): ApiPlaygroundFieldOption[] {
  return wallets.map((wallet) => ({
    value: wallet.walletId,
    label: wallet.label?.trim() ? `${wallet.label} (${wallet.walletId})` : wallet.walletId,
  }));
}

function buildTransferOptions(
  transfers: PaymentsPlaygroundTransferView[]
): ApiPlaygroundFieldOption[] {
  return transfers.map((transfer) => ({
    value: transfer.id,
    label: `${transfer.id} (${transfer.status})`,
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

export function buildPaymentsPlaygroundEndpointConfigs({
  transfers,
  wallets,
}: BuildPaymentsPlaygroundConfigOptions): ApiPlaygroundEndpointConfig[] {
  const walletOptions = buildWalletOptions(wallets);
  const transferOptions = buildTransferOptions(transfers);
  const walletIdField = buildSelectBackedField(
    "walletId",
    "{walletId}",
    "Wallet ID (e.g. wal_ops_123)",
    walletOptions
  );
  const transferIdField = buildSelectBackedField(
    "transferId",
    "{transferId}",
    "Transfer ID (e.g. xfr_123)",
    transferOptions
  );
  const sourceField = buildSelectBackedField(
    "source",
    "source",
    "Custody wallet ID (e.g. wal_ops_123)",
    walletOptions
  );
  const destinationWalletField = buildSelectBackedField(
    "destinationWallet",
    "destinationWallet",
    "Destination wallet ID",
    walletOptions
  );
  const sourceWalletField = buildSelectBackedField(
    "sourceWallet",
    "sourceWallet",
    "Source wallet ID",
    walletOptions
  );
  const firstWallet = wallets[0];
  const firstTransfer = transfers[0];
  const exampleWalletId = firstWallet?.walletId ?? "wal_ops_123";
  const exampleWalletAddress = firstWallet?.publicKey ?? exampleWalletAddressFallback;
  const exampleTransferId = firstTransfer?.id ?? "xfr_live_123";

  return [
    {
      id: "wallet-balances",
      title: "Get Wallet Balances",
      method: "GET",
      path: "/v1/payments/wallets/{walletId}/balances",
      pathFields: [walletIdField],
      bodyFields: [],
      expectedResponse: {
        data: {
          walletId: exampleWalletId,
          address: exampleWalletAddress,
          balances: [
            {
              token: "USDC",
              mint: exampleMintAddress,
              amount: "100000000",
              uiAmount: "100.00",
              decimals: 6,
            },
          ],
        },
      },
    },
    {
      id: "get-wallet-policy",
      title: "Get Wallet Policy",
      method: "GET",
      path: "/v1/payments/wallets/{walletId}/policies",
      pathFields: [walletIdField],
      bodyFields: [],
      expectedResponse: {
        data: {
          policy: {
            walletId: exampleWalletId,
            destinationAllowlist: [exampleWalletAddress],
            maxTransferAmount: "2500",
            maxDailyAmount: "25000",
          },
        },
      },
    },
    {
      id: "update-wallet-policy",
      title: "Update Wallet Policy",
      method: "PUT",
      path: "/v1/payments/wallets/{walletId}/policies",
      pathFields: [walletIdField],
      bodyFields: [
        {
          key: destinationAllowlistFieldKey,
          label: destinationAllowlistFieldKey,
          placeholder: "Comma-separated destination addresses",
          defaultValue: exampleWalletAddress,
          valueType: "string_array",
          required: true,
        },
        {
          key: maxTransferAmountFieldKey,
          label: maxTransferAmountFieldKey,
          placeholder: "2500",
        },
        {
          key: maxDailyAmountFieldKey,
          label: maxDailyAmountFieldKey,
          placeholder: "25000",
        },
      ],
      expectedResponse: {
        data: {
          policy: {
            walletId: exampleWalletId,
            destinationAllowlist: [exampleWalletAddress],
            maxTransferAmount: "2500",
            maxDailyAmount: "25000",
          },
        },
      },
    },
    {
      id: "execute-transfer",
      title: "Execute Transfer",
      method: "POST",
      path: "/v1/payments/transfers",
      pathFields: [],
      bodyFields: [
        sourceField,
        {
          key: "destination",
          label: "destination",
          placeholder: "Solana address (32-44 chars)",
          required: true,
        },
        {
          key: "token",
          label: "token",
          placeholder: "USDC",
          defaultValue: "USDC",
          required: true,
        },
        {
          key: "amount",
          label: "amount",
          placeholder: "100.00",
          defaultValue: "100.00",
          required: true,
        },
        {
          key: "memo",
          label: "memo",
          placeholder: "Optional memo",
        },
      ],
      expectedResponse: {
        data: {
          transfer: {
            id: exampleTransferId,
            status: "processing",
            signature: "5P7B...",
          },
        },
      },
    },
    {
      id: "list-transfers",
      title: "List Transfers",
      method: "GET",
      path: "/v1/payments/transfers",
      pathFields: [],
      bodyFields: [],
      expectedResponse: {
        data:
          transfers.length > 0
            ? transfers.map((transfer) => ({
                id: transfer.id,
                status: transfer.status,
              }))
            : [
                {
                  id: exampleTransferId,
                  status: "confirmed",
                },
              ],
      },
    },
    {
      id: "get-transfer",
      title: "Get Transfer",
      method: "GET",
      path: "/v1/payments/transfers/{transferId}",
      pathFields: [transferIdField],
      bodyFields: [],
      expectedResponse: {
        data: {
          transfer: {
            id: exampleTransferId,
            status: firstTransfer?.status ?? "confirmed",
            signature: "5P7B...",
          },
        },
      },
    },
    {
      id: "create-onramp-quote",
      title: "Create Onramp Quote",
      method: "POST",
      path: "/v1/payments/ramps/onramp/quote",
      pathFields: [],
      bodyFields: [
        {
          key: "provider",
          label: "provider",
          placeholder: "Select provider",
          kind: "select",
          options: rampProviderOptions,
          defaultValue: "moonpay",
          required: true,
        },
        {
          key: "counterpartyId",
          label: "counterpartyId",
          placeholder: "Counterparty ID (e.g. cpty_abc123)",
          required: true,
        },
        destinationWalletField,
        {
          key: "cryptoToken",
          label: "cryptoToken",
          placeholder: "USDC",
          defaultValue: "USDC",
          required: true,
        },
        {
          key: "fiatCurrency",
          label: "fiatCurrency",
          placeholder: "Select fiat currency",
          kind: "select",
          options: fiatCurrencyOptions,
          defaultValue: "USD",
        },
        {
          key: "fiatAmount",
          label: "fiatAmount",
          placeholder: "250.00",
          defaultValue: "250.00",
          required: true,
        },
        {
          key: "redirectUrl",
          label: "redirectUrl",
          placeholder: "https://app.example.com/payments/onramp/complete",
        },
      ],
      expectedResponse: {
        data: {
          quote: {
            id: "ramp_quote_example",
            provider: "moonpay",
            status: "pending",
            deliveryMode: "hosted",
            hostedUrl: "https://buy.moonpay.com/session_123",
          },
        },
      },
    },
    {
      id: "create-offramp-quote",
      title: "Create Offramp Quote",
      method: "POST",
      path: "/v1/payments/ramps/offramp/quote",
      pathFields: [],
      bodyFields: [
        {
          key: "provider",
          label: "provider",
          placeholder: "Select provider",
          kind: "select",
          options: rampProviderOptions,
          defaultValue: "moonpay",
          required: true,
        },
        {
          key: "counterpartyId",
          label: "counterpartyId",
          placeholder: "Counterparty ID (e.g. cpty_abc123)",
          required: true,
        },
        sourceWalletField,
        {
          key: "cryptoToken",
          label: "cryptoToken",
          placeholder: "USDC",
          defaultValue: "USDC",
          required: true,
        },
        {
          key: "fiatCurrency",
          label: "fiatCurrency",
          placeholder: "Select fiat currency",
          kind: "select",
          options: fiatCurrencyOptions,
          defaultValue: "USD",
        },
        {
          key: "cryptoAmount",
          label: "cryptoAmount",
          placeholder: "250.00",
          defaultValue: "250.00",
          required: true,
        },
        {
          key: "redirectUrl",
          label: "redirectUrl",
          placeholder: "https://app.example.com/payments/offramp/complete",
        },
      ],
      expectedResponse: {
        data: {
          quote: {
            id: "ramp_quote_example",
            provider: "moonpay",
            status: "pending",
            deliveryMode: "hosted",
            hostedUrl: "https://sell.moonpay.com/session_123",
          },
        },
      },
    },
  ];
}
