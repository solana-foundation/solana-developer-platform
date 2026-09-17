import type {
  BvnkAgreementActionResultsV2,
  BvnkAgreementContentV2,
  BvnkAgreementsV2,
  BvnkCustomerV2,
  BvnkCustomerV2Detail,
  BvnkCustomerV2Individual,
  BvnkLedgerWalletProfilesV2,
  BvnkLedgerWalletV2,
} from "./schemas";

export function bvnkIndividualCustomer(
  overrides?: Partial<BvnkCustomerV2Individual>
): BvnkCustomerV2Individual {
  return {
    address: {
      addressLine1: "1 Main Street",
      city: "Austin",
      postalCode: "78701",
      stateCode: "TX",
      countryCode: "US",
    },
    dateOfBirth: "1984-06-30",
    firstName: "Jane",
    lastName: "Doe",
    birthCountryCode: "US",
    nationality: "US",
    taxIdentification: { number: "123-45-6789", taxResidenceCountryCode: "US" },
    cdd: {
      employmentStatus: "SALARIED",
      sourceOfFunds: "SALARY",
      pepStatus: "NOT_PEP",
      intendedUseOfAccount: "TRANSFERS_OWN_WALLET",
      expectedMonthlyVolume: { amount: "1000", currency: "USD" },
      estimatedYearlyIncome: "INCOME_0_TO_50K",
      employmentIndustrySector: "INVESTMENT",
    },
    ...overrides,
  } satisfies BvnkCustomerV2Individual;
}

export function bvnkCustomerSummary(overrides?: Partial<BvnkCustomerV2>): BvnkCustomerV2 {
  return {
    id: "customer-id",
    reference: "customer-reference",
    status: "PENDING",
    type: "INDIVIDUAL",
    model: "EMBEDDED",
    useCase: "STABLECOIN_PAYOUTS",
    ...overrides,
  } satisfies BvnkCustomerV2;
}

export function bvnkCustomerDetailV2(
  overrides?: Partial<BvnkCustomerV2Detail>
): BvnkCustomerV2Detail {
  return {
    ...bvnkCustomerSummary(),
    status: "ACTIONS_REQUIRED",
    authenticatedLink: {
      link: "https://onboarding.example/customer",
      expiresAt: "2030-01-01T00:00:00Z",
    },
    requiredActions: [{ type: "DATA", code: "TAX_ID", status: "REQUIRED" }],
    ...overrides,
  } satisfies BvnkCustomerV2Detail;
}

export function bvnkAgreementWorkingSet(overrides?: Partial<BvnkAgreementsV2>): BvnkAgreementsV2 {
  return {
    id: "working-set-id",
    reference: "customer-reference",
    agreements: [
      {
        id: "agreement-id",
        status: "PENDING",
        declinable: false,
        name: "Terms",
        description: "Platform terms and conditions",
      },
    ],
    signingUrl: "https://onboarding.example/sign",
    ...overrides,
  } satisfies BvnkAgreementsV2;
}

export function bvnkAgreementContent(
  overrides?: Partial<BvnkAgreementContentV2>
): BvnkAgreementContentV2 {
  return {
    downloadUrl: "https://files.example/agreement.pdf",
    expiresAt: null,
    ...overrides,
  } satisfies BvnkAgreementContentV2;
}

export function bvnkAgreementActionsResponse(
  overrides?: Partial<BvnkAgreementActionResultsV2>
): BvnkAgreementActionResultsV2 {
  return {
    content: [{ agreementId: "agreement-id", status: "ACCEPTED" }],
    totalElements: 1,
    totalPages: 1,
    hasNext: false,
    ...overrides,
  } satisfies BvnkAgreementActionResultsV2;
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
