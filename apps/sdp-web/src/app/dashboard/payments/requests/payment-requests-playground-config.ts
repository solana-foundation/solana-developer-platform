import type { PaymentsDashboardWallet } from "@sdp/types";
import type {
  ApiPlaygroundEndpointConfig,
  ApiPlaygroundFieldConfig,
} from "@/components/api-playground-shell";
import type { PaymentRequestTokenOption } from "./payment-requests-page.data";

const exampleRequest = {
  id: "preq_abc123",
  publicToken: "example-public-token",
  status: "awaiting_payment",
  amount: "10.00",
  token: "EXAMPLE_TOKEN_MINT",
  destinationAddress: "EXAMPLE_WALLET_ADDRESS",
  reference: "EXAMPLE_REFERENCE_ADDRESS",
  expiresAt: null,
  createdAt: "2026-06-24T12:00:00.000Z",
};

export function buildPaymentRequestsPlaygroundEndpointConfigs(
  wallets: PaymentsDashboardWallet[],
  tokens: PaymentRequestTokenOption[]
): ApiPlaygroundEndpointConfig[] {
  const walletOptions = wallets.map((wallet) => ({
    value: wallet.walletId,
    label: wallet.label ? wallet.label : wallet.publicKey,
  }));
  const tokenOptions = tokens.map((token) => ({ value: token.mintAddress, label: token.symbol }));

  const firstWallet = walletOptions.at(0);
  const walletField: ApiPlaygroundFieldConfig = firstWallet
    ? {
        key: "walletId",
        label: "walletId",
        kind: "select",
        options: walletOptions,
        defaultValue: firstWallet.value,
        required: true,
      }
    : { key: "walletId", label: "walletId", placeholder: "Destination wallet ID", required: true };

  const firstToken = tokenOptions.at(0);
  const tokenField: ApiPlaygroundFieldConfig = firstToken
    ? {
        key: "token",
        label: "token",
        kind: "select",
        options: tokenOptions,
        defaultValue: firstToken.value,
        required: true,
      }
    : { key: "token", label: "token", placeholder: "SPL mint address", required: true };

  return [
    {
      id: "list-payment-requests",
      title: "List Payment Requests",
      method: "GET",
      path: "/v1/payments/requests",
      pathFields: [],
      bodyFields: [],
      expectedResponse: { paymentRequests: [exampleRequest], total: 1, page: 1, pageSize: 20 },
    },
    {
      id: "create-payment-request",
      title: "Create Payment Request",
      method: "POST",
      path: "/v1/payments/requests",
      pathFields: [],
      bodyFields: [
        walletField,
        tokenField,
        { key: "amount", label: "amount", placeholder: "10.00", required: true },
        {
          key: "expiresAt",
          label: "expiresAt",
          placeholder: "2026-07-01T00:00:00.000Z",
        },
      ],
      expectedResponse: exampleRequest,
    },
  ];
}
