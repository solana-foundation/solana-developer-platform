import type {
  BvnkContactV3,
  BvnkLedgerWalletProfilesV2,
  BvnkLedgerWalletV2,
} from "./schemas";

export function bvnkContactV3(overrides?: Partial<BvnkContactV3>): BvnkContactV3 {
  return {
    id: "a3700c37-3f46-4766-b0db-3250b073fd9c",
    description: "cpty_123e4567-e89b-12d3-a456-426614174000",
    entity: {
      type: "INDIVIDUAL",
      relationshipType: "THIRD_PARTY",
      firstName: "Jane",
      lastName: "Doe",
    },
    createdAt: "2026-06-10T10:30:00Z",
    updatedAt: "2026-06-10T10:30:00Z",
    ...overrides,
  } satisfies BvnkContactV3;
}

export function bvnkLedgerWallet(overrides?: Partial<BvnkLedgerWalletV2>): BvnkLedgerWalletV2 {
  return {
    id: "wallet-id",
    name: "USD Wallet",
    status: "ACTIVE",
    paymentInstruments: [
      {
        type: "FIAT",
        accountHolderName: "Jane Doe",
        accountNumber: "123456789",
        bankDetails: {
          name: "Example Bank",
          bic: "EXAMPLEUS",
          nid: { value: "021000021", type: "ROUTING_NUMBER" },
        },
        remittanceInformationPrefix: "REF-123",
      },
    ],
    ...overrides,
  } satisfies BvnkLedgerWalletV2;
}

export function bvnkWalletProfilesResponse(
  overrides?: Partial<BvnkLedgerWalletProfilesV2>
): BvnkLedgerWalletProfilesV2 {
  return {
    totalElements: 1,
    totalPages: 1,
    content: [{ id: "fiat:usd:profile", currencies: ["USD"], methods: ["ACH", "FEDWIRE"] }],
    hasNext: false,
    ...overrides,
  } satisfies BvnkLedgerWalletProfilesV2;
}
