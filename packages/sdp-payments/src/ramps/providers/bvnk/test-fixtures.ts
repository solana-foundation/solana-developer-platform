import type {
  BvnkAgreementSession,
  BvnkCustomer,
  BvnkCustomerCreated,
  BvnkCustomerIndividual,
  BvnkLedgerWalletProfilesV2,
  BvnkLedgerWalletV2,
} from "./schemas";

export function bvnkIndividualCustomer(
  overrides?: Partial<BvnkCustomerIndividual>
): BvnkCustomerIndividual {
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
  } satisfies BvnkCustomerIndividual;
}

export function bvnkAgreementSession(
  overrides?: Partial<BvnkAgreementSession>
): BvnkAgreementSession {
  return {
    reference: "c1d91c8b-f4a6-469e-953d-7344fdb6858c",
    status: "PENDING",
    agreements: [
      {
        status: "PENDING",
        name: "EMBEDDED_PARTNER_PLATFORM_CUSTOMERS_US",
        displayName: "Embedded US Partner Platform Customers Agreement",
        description: "Embedded US Partner Platform Customers Agreement",
        url: "https://help.bvnk.com/hc/en-us/sections/27816998470930-BVNK-US-Partner-Platform-Customers",
        privacyPolicyUrl: "https://help.bvnk.com/hc/en-us/articles/7662076884882-Privacy-Policy",
      },
    ],
    ...overrides,
  } satisfies BvnkAgreementSession;
}

export function bvnkCustomerCreated(overrides?: Partial<BvnkCustomerCreated>): BvnkCustomerCreated {
  return {
    reference: "2a9c8a29-5030-456d-87c2-7f6cc2ee6bf3",
    status: "PENDING",
    ...overrides,
  } satisfies BvnkCustomerCreated;
}

export function bvnkCustomer(overrides?: Partial<BvnkCustomer>): BvnkCustomer {
  return {
    reference: "2a9c8a29-5030-456d-87c2-7f6cc2ee6bf3",
    status: "INFO_REQUIRED",
    verification: {
      status: "init",
      // biome-ignore lint/security/noSecrets: synthetic sandbox Sumsub link, not a credential
      url: "https://in.sumsub.com/websdk/p/sbx_EDHeJPPmWnBSU2Es",
    },
    ...overrides,
  } satisfies BvnkCustomer;
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
