import type {
  BvnkContactV3,
  BvnkLedgerWalletProfilesV2,
  BvnkLedgerWalletV2,
  BvnkRuleListEntry,
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
    balance: { amount: "10.00", currency: "USD" },
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

export function bvnkRuleListEntry(overrides?: Partial<BvnkRuleListEntry>): BvnkRuleListEntry {
  return {
    id: "98c0bb03-567f-11f0-b26e-6b1848874a27",
    reference: "sdp_onramp_xfr_123e4567-e89b-12d3-a456-426614174000",
    trigger: "payment:payin:fiat",
    status: "ACTIVE",
    originator: { currency: "USD", walletId: "acc:22041242429000:3MPpU:0" },
    beneficiary: {
      currency: "USDC",
      cryptoAddresses: { network: "SOLANA", addresses: ["dest-address"] },
    },
    ...overrides,
  } satisfies BvnkRuleListEntry;
}
