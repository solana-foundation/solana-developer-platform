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

export const BVNK_CHANNEL_CREATED_WEBHOOK = {
  event: "bvnk:payment:channel:created",
  eventId: "01000000-0000-7000-8000-00000000e001",
  timestamp: "2026-09-22T03:20:09.893Z",
  data: {
    uuid: "01000000-0000-7000-8000-00000000c001",
    merchantId: "00000000-0000-4000-8000-0000000000aa",
    walletId: "a:10000000000001:TESTWLT:1",
    merchantDisplayName: "test-channel-display-name",
    reference: "xfr_00000000-0000-4000-8000-0000000000f1",
    dateCreated: 1790047209799,
    lastUpdated: 1790047209799,
    status: "OPEN",
    payCurrency: "USDC",
    displayCurrency: "USD",
    walletCurrency: "USD",
    address: "0x000000000000000000000000000000000000c0de",
    protocol: "ERC20",
    network: "ETHEREUM",
    uri: "ethereum:0x0000000000000000000000000000000000000001/transfer?address=0x000000000000000000000000000000000000c0de&uint256={amount}",
    redirectUrl: "https://pay.sandbox.bvnk.com/channel/01000000-0000-7000-8000-00000000c001",
    alternatives: [
      {
        protocol: "SOL",
        address: "TestSo1anaDepos1tAddress1111111111111111111",
        network: "SOLANA",
      },
      {
        protocol: "ARBITRUM",
        address: "0x000000000000000000000000000000000000c0de",
        network: "ARBITRUM",
      },
      {
        protocol: "POLYGON",
        address: "0x000000000000000000000000000000000000c0de",
        network: "POLYGON",
      },
      {
        protocol: "BASE",
        address: "0x000000000000000000000000000000000000c0de",
        network: "BASE",
      },
      {
        protocol: "ARC",
        address: "0x000000000000000000000000000000000000c0de",
        network: "ARC",
      },
      {
        protocol: "BEP20",
        address: "0x000000000000000000000000000000000000c0de",
        network: "BINANCE",
      },
    ],
    contact: {
      id: "00000000-0000-4000-8000-0000000000c7",
      name: "[redacted]",
      externalId: "00000000-0000-4000-8000-00000000c057",
      relationshipType: "THIRD_PARTY",
      entityType: "INDIVIDUAL",
    },
    pegged: false,
    accountReference: "00000000-0000-4000-8000-0000000000ac",
    meshEnabled: false,
    embeddedCustomerDetails: {
      reference: "00000000-0000-4000-8000-00000000c057",
    },
  },
} as const;

export const BVNK_CHANNEL_TRANSACTION_CONFIRMED_WEBHOOK = {
  event: "bvnk:payment:channel:transaction-confirmed",
  eventId: "01000000-0000-7000-8000-00000000e002",
  timestamp: "2026-09-22T04:41:58.624Z",
  data: {
    channelId: "01000000-0000-7000-8000-00000000c002",
    merchantId: "00000000-0000-4000-8000-0000000000aa",
    walletId: "a:10000000000002:TESTWLT:1",
    merchantDisplayName:
      "sdp:onramp:counterparty_provider_account_00000000-0000-4000-8000-0000000000cf",
    reference: "sdp_offramp_xfr_00000000-0000-4000-8000-0000000000f2",
    dateCreated: 1790051985000,
    lastUpdated: 1790052118171,
    status: "COMPLETE",
    uuid: "01000000-0000-7000-8000-00000000c7a1",
    hash: "TestDepos1tS1gnature11111111111111111111111111111111111111111111111111111111111111111111",
    address: "TestChanne1Depos1tAddress111111111111111111",
    tag: null,
    paidCurrency: "USDC",
    displayCurrency: "USD",
    walletCurrency: "USD",
    feeCurrency: "USD",
    paidAmount: 10,
    displayAmount: 9.9,
    walletAmount: 9.9,
    feeAmount: 0.09,
    exchangeRate: {
      base: "USDC",
      counter: "USD",
      rate: 0.99,
      baseAmount: 10,
      counterAmount: 9.9,
    },
    displayRate: {
      base: "USDC",
      counter: "USD",
      rate: 0.99,
      baseAmount: 10,
      counterAmount: 9.9,
    },
    risk: {
      level: "UNKNOWN",
      resourceName: "UNKNOWN",
      resourceCategory: "UNKNOWN",
      alerts: [],
    },
    sources: [
      "TestSourceWa11etOne111111111111111111111111",
      "TestSourceWa11etTwo111111111111111111111111",
    ],
    networkFee: {
      paidCurrency: "SOL",
      paidAmount: 1e-5,
      displayCurrency: "USD",
      displayAmount: 0,
    },
    pegged: false,
    metaData: null,
    originator: null,
    embeddedCustomerDetails: {
      reference: "00000000-0000-4000-8000-00000000c058",
    },
  },
} as const;
