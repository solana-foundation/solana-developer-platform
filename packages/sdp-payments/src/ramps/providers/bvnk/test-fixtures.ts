import type {
  BvnkContactV3,
  BvnkLedgerWalletProfilesV2,
  BvnkLedgerWalletV2,
  BvnkRuleListEntry,
} from "./schemas";

/**
 * The raw BVNK wire shape for a v2 ledger wallet, before the client converts
 * the numeric balance into a decimal string. Fixtures for HTTP responses must
 * model this shape — `balance.amount` is a number and `paymentInstruments`
 * is a required array — or the tightened schema rejects the body as
 * malformed.
 */
export type BvnkLedgerWalletWire = Omit<BvnkLedgerWalletV2, "balance"> & {
  balance: { amount: number; currency: string };
};

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

export function bvnkLedgerWallet(overrides?: Partial<BvnkLedgerWalletWire>): BvnkLedgerWalletWire {
  return {
    id: "wallet-id",
    name: "USD Wallet",
    status: "ACTIVE",
    balance: { amount: 0, currency: "USD" },
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
  } satisfies BvnkLedgerWalletWire;
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
