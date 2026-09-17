import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import {
  buildBvnkOfframpWalletName,
  buildBvnkOnrampRuleReference,
} from "@sdp/payments/ramps/providers/bvnk/provider-data";
import type { RequirementField } from "@sdp/types/ramp-requirements";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import { env as testEnv } from "@/test/helpers/env";
import type { AppContext } from "../../context";
import { rampRuntime } from "../../context";
import {
  advanceBvnkContact,
  bvnkContactFields,
  bvnkOnrampQuote,
  ensureBvnkSettlementWallet,
} from "./bvnk";

const mockTransaction = vi.hoisted(() => ({}));

const mockAccounts = vi.hoisted(() => ({
  getPendingCustomerLink: vi.fn(),
  claimPendingCustomerLink: vi.fn(),
  completeCustomerLink: vi.fn(),
  getProviderAccount: vi.fn(),
  getVirtualFundingWallet: vi.fn(),
  getVirtualSettlementWallet: vi.fn(),
  insertPendingVirtualSettlementWallet: vi.fn(),
  completeVirtualSettlementWalletReference: vi.fn(),
}));

const mockPayments = vi.hoisted(() => ({
  createTransfer: vi.fn(),
  getInFlightBvnkOnrampTransferByFundingWallet: vi.fn(),
  findInFlightTransferByBvnkRuleId: vi.fn(),
  bindBvnkOnrampRule: vi.fn(),
  updateTransferStatusGuarded: vi.fn(),
}));

vi.mock("@/db", () => ({
  getDb: () => ({
    transaction: async (fn: (transaction: unknown) => Promise<unknown>) => fn(mockTransaction),
  }),
  asTransactionalClient: (transaction: unknown) => transaction as never,
}));
vi.mock("@/db/repositories/counterparty-provider-account.repository.postgres", () => ({
  createPostgresCounterpartyProviderAccountsRepository: () => mockAccounts,
}));
// The handler reaches the payments repository through three doors — the
// request context, the transaction client, and the system constructor — and
// every one of them hands back the same mock object.
vi.mock("@/db/repositories", () => ({
  createPaymentsRepository: () => mockPayments,
  createSystemPaymentsRepository: () => mockPayments,
  createSystemTransactionalPaymentsRepository: () => mockPayments,
}));
vi.mock("@/routes/payments/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/routes/payments/context")>()),
  getPaymentsRepository: () => mockPayments,
}));

const COUNTERPARTY_ID = "cpty_123e4567-e89b-12d3-a456-426614174000";
const PROJECT_ID = "prj_test";
const CONTACT_ID = "contact_created_1";

/** The ramp runtime context the settlement-wallet handler is invoked with. */
const RAMP_CTX = rampRuntime(fakeContext());

/** The virtual funding wallet CPA row id; the transfer's lock key. */
const FUNDING_ACCOUNT_ID = "counterparty_provider_account_funding_usd";
const WALLET_ID = "a:1:wallet:1";
/** The virtual settlement wallet CPA row id claimed at off-ramp quote time. */
const SETTLEMENT_ACCOUNT_ID = "counterparty_provider_account_settlement_usd";
/** The BVNK ledger wallet id bound to the settlement wallet row. */
const OFFRAMP_WALLET_ID = "a:99887766554433:OffRmpW:1";
const TRANSFER_ID = "xfr_123e4567-e89b-12d3-a456-426614174000";
const DESTINATION_WALLET_ADDRESS = "J4t4M6zJH3M6ewN9pmRUpMt2EMWXXCFPYvnrD9ck9EEi";

function fakeContext(): AppContext {
  return {
    env: testEnv,
    get: (key: string) => (key === "apiKey" ? { environment: "sandbox" } : undefined),
  } as unknown as AppContext;
}

function counterpartyRow(overrides?: Partial<CounterpartyRow>): CounterpartyRow {
  return {
    id: COUNTERPARTY_ID,
    organization_id: "org_test",
    project_id: PROJECT_ID,
    external_id: null,
    entity_type: "individual",
    display_name: "BVNK Test Counterparty",
    provider_data: {},
    status: "active",
    created_by: null,
    created_at: "2026-06-28T00:00:00.000Z",
    updated_at: "2026-06-28T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * The customer-link row `claimPendingCustomerLink` returns: kind
 * `customer_link`, status `pending`, reference NULL — claimed inside the
 * advance's claim transaction (committed before any BVNK call), bound by the
 * standalone CAS once the contact exists.
 */
function pendingCustomerLinkRow(): Record<string, unknown> {
  return {
    id: "counterparty_provider_account_contact_claim",
    organization_id: "org_test",
    project_id: PROJECT_ID,
    counterparty_id: COUNTERPARTY_ID,
    provider: "bvnk",
    provider_customer_reference: null,
    kind: "customer_link",
    external_account_reference: null,
    fiat_currency: null,
    destination_country: null,
    payment_rail: null,
    provider_status: null,
    status: "pending",
    metadata: {},
    created_at: "2026-06-28T00:00:00.000Z",
    updated_at: "2026-06-28T00:00:00.000Z",
  };
}

/** The active per-counterparty customer-link row the quote resolves first. */
function customerLinkRow(): Record<string, unknown> {
  return {
    id: "counterparty_provider_account_contact",
    organization_id: "org_test",
    project_id: PROJECT_ID,
    counterparty_id: COUNTERPARTY_ID,
    provider: "bvnk",
    provider_customer_reference: CONTACT_ID,
    kind: "customer_link",
    external_account_reference: null,
    fiat_currency: null,
    destination_country: null,
    payment_rail: null,
    provider_status: null,
    status: "active",
    metadata: {},
    created_at: "2026-06-28T00:00:00.000Z",
    updated_at: "2026-06-28T00:00:00.000Z",
  };
}

/** The per-(counterparty, fiat) virtual funding wallet row, keyed by wallet id. */
function fundingWalletRow(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: FUNDING_ACCOUNT_ID,
    organization_id: "org_test",
    project_id: PROJECT_ID,
    counterparty_id: COUNTERPARTY_ID,
    provider: "bvnk",
    provider_customer_reference: "",
    kind: "virtual_funding_wallet",
    external_account_reference: WALLET_ID,
    fiat_currency: "USD",
    destination_country: null,
    payment_rail: null,
    provider_status: "ACTIVE",
    status: "active",
    metadata: {},
    created_at: "2026-06-28T00:00:00.000Z",
    updated_at: "2026-06-28T00:00:00.000Z",
    ...overrides,
  };
}

/** The per-(counterparty, fiat) virtual settlement wallet row, keyed by wallet id. */
function settlementWalletRow(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: SETTLEMENT_ACCOUNT_ID,
    organization_id: "org_test",
    project_id: PROJECT_ID,
    counterparty_id: COUNTERPARTY_ID,
    provider: "bvnk",
    provider_customer_reference: "",
    kind: "virtual_settlement_wallet",
    external_account_reference: OFFRAMP_WALLET_ID,
    fiat_currency: "USD",
    destination_country: null,
    payment_rail: null,
    provider_status: "ACTIVE",
    status: "active",
    metadata: {},
    created_at: "2026-06-28T00:00:00.000Z",
    updated_at: "2026-06-28T00:00:00.000Z",
    ...overrides,
  };
}

function bvnkContact(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: CONTACT_ID,
    type: "INDIVIDUAL",
    firstName: "Ada",
    lastName: "Lovelace",
    description: COUNTERPARTY_ID,
    ...overrides,
  };
}

/** Full collect pack for an individual BVNK contact: DOB plus the address block. */
const INDIVIDUAL_COLLECTED = {
  firstName: "Ada",
  lastName: "Lovelace",
  dateOfBirth: "1815-12-10",
  "address.addressLine1": "1 Analytical Engine Way",
  "address.city": "Austin",
  "address.postalCode": "78701",
  "address.country": "US",
  "address.stateCode": "TX",
};

/** Individual collect pack without a state code, for the US-state rule cases. */
const INDIVIDUAL_COLLECTED_NO_STATE = {
  firstName: "Ada",
  lastName: "Lovelace",
  dateOfBirth: "1815-12-10",
  "address.addressLine1": "1 Analytical Engine Way",
  "address.city": "Austin",
  "address.postalCode": "78701",
  "address.country": "US",
};

/** Company collect pack: registration number plus a non-US address block. */
const COMPANY_COLLECTED = {
  legalName: "Acme Widgets Ltd",
  registrationNumber: "01234567",
  "address.addressLine1": "20 Finsbury Circus",
  "address.city": "London",
  "address.postalCode": "EC2M 7DT",
  "address.country": "GB",
};

function transferRow(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: TRANSFER_ID,
    organization_id: "org_test",
    project_id: PROJECT_ID,
    counterparty_id: COUNTERPARTY_ID,
    status: "awaiting_payment",
    provider: "bvnk",
    provider_data: { bvnk: { fundingWalletAccountId: FUNDING_ACCOUNT_ID } },
    ...overrides,
  };
}

/** provider_data for a transfer whose rule id is already bound to the row. */
const BOUND_RULE_PROVIDER_DATA = {
  provider_data: {
    bvnk: {
      fundingWalletAccountId: FUNDING_ACCOUNT_ID,
      ruleId: "rule_active_1",
      ruleStatus: "ACTIVE",
    },
  },
};

/** A BVNK rule-list entry, shaped like `BvnkRuleListEntry`. */
function ruleEntry(
  id: string,
  reference: string,
  status = "ACTIVE"
): {
  id: string;
  reference: string;
  status: string;
} {
  return { id, reference, status };
}

/** The quote input, as the on-ramp quote route builds it. */
function onrampRequest(
  overrides: Partial<Parameters<typeof bvnkOnrampQuote>[1]> = {}
): Parameters<typeof bvnkOnrampQuote>[1] {
  return {
    counterparty: counterpartyRow(),
    organizationId: "org_test",
    projectId: PROJECT_ID,
    destinationCustodyWalletId: "cwlt_quote_destination",
    destinationWalletId: "wallet_quote_destination",
    destinationWalletAddress: DESTINATION_WALLET_ADDRESS,
    transferId: TRANSFER_ID,
    assetRail: "usdc.solana",
    currency: "USDC",
    network: "SOLANA",
    fiatCurrency: "USD",
    fiatAmount: "100.00",
    rampsMemo: undefined,
    ...overrides,
  };
}

function uniqueViolationError(): Error & { code: string } {
  return Object.assign(new Error("duplicate key value violates unique constraint"), {
    code: "23505",
  });
}

function bvnkLedgerWallet(status = "ACTIVE"): Record<string, unknown> {
  return {
    id: WALLET_ID,
    name: `sdp:onramp:${COUNTERPARTY_ID}:USD`,
    status,
    balance: { amount: "1.50", currency: "USD" },
    paymentInstruments: [
      {
        type: "FIAT",
        accountHolderName: "SDP",
        accountNumber: "900473221558",
        bankDetails: { bic: "LEADUS49XXX", name: "LEAD BANK" },
      },
    ],
  };
}

describe("advanceBvnkContact", () => {
  let createContact: ReturnType<typeof vi.spyOn>;
  let listContacts: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    createContact = vi.spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "createContactV3");
    listContacts = vi.spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "listContactsV3");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("advances collect into a BVNK contact, claiming the row before the provider call", async () => {
    mockAccounts.getPendingCustomerLink.mockResolvedValue(null);
    mockAccounts.claimPendingCustomerLink.mockResolvedValue(pendingCustomerLinkRow());
    createContact.mockResolvedValue(bvnkContact({ id: CONTACT_ID }));
    mockAccounts.completeCustomerLink.mockResolvedValue({
      ...pendingCustomerLinkRow(),
      provider_customer_reference: CONTACT_ID,
      status: "active",
    });

    const result = await advanceBvnkContact(fakeContext(), {
      counterparty: counterpartyRow(),
      projectId: PROJECT_ID,
      collectedData: INDIVIDUAL_COLLECTED,
    });

    expect(result).toEqual({ contactId: CONTACT_ID });
    // The row is claimed exactly once and before any BVNK call, so a crash
    // after the provider call leaves a recoverable pending row.
    expect(mockAccounts.claimPendingCustomerLink).toHaveBeenCalledTimes(1);
    expect(mockAccounts.claimPendingCustomerLink.mock.invocationCallOrder[0]).toBeLessThan(
      createContact.mock.invocationCallOrder[0]
    );
    expect(listContacts).not.toHaveBeenCalled();
    expect(createContact).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        description: COUNTERPARTY_ID,
        entity: expect.objectContaining({
          type: "INDIVIDUAL",
          relationshipType: "THIRD_PARTY",
          firstName: "Ada",
          lastName: "Lovelace",
          dateOfBirth: "1815-12-10",
          address: {
            addressLine1: "1 Analytical Engine Way",
            city: "Austin",
            postalCode: "78701",
            country: "US",
            stateCode: "TX",
          },
        }),
      })
    );
    // The contact id is CAS-written onto the claimed row, leaving it bound.
    expect(mockAccounts.completeCustomerLink).toHaveBeenCalledWith({
      organizationId: "org_test",
      projectId: PROJECT_ID,
      counterpartyId: COUNTERPARTY_ID,
      provider: "bvnk",
      id: "counterparty_provider_account_contact_claim",
      providerCustomerReference: CONTACT_ID,
    });
  });

  it("creates a company contact from the collected legal name", async () => {
    mockAccounts.getPendingCustomerLink.mockResolvedValue(null);
    mockAccounts.claimPendingCustomerLink.mockResolvedValue(pendingCustomerLinkRow());
    createContact.mockResolvedValue(
      bvnkContact({ id: CONTACT_ID, type: "COMPANY", legalName: "Acme Widgets Ltd" })
    );
    mockAccounts.completeCustomerLink.mockResolvedValue({
      ...pendingCustomerLinkRow(),
      provider_customer_reference: CONTACT_ID,
      status: "active",
    });

    const result = await advanceBvnkContact(fakeContext(), {
      counterparty: counterpartyRow({ entity_type: "business" }),
      projectId: PROJECT_ID,
      collectedData: COMPANY_COLLECTED,
    });

    expect(result).toEqual({ contactId: CONTACT_ID });
    expect(createContact).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        description: COUNTERPARTY_ID,
        entity: expect.objectContaining({
          type: "COMPANY",
          relationshipType: "THIRD_PARTY",
          legalName: "Acme Widgets Ltd",
          registrationNumber: "01234567",
          address: {
            addressLine1: "20 Finsbury Circus",
            city: "London",
            postalCode: "EC2M 7DT",
            country: "GB",
          },
        }),
      })
    );
    expect(mockAccounts.completeCustomerLink).toHaveBeenCalledWith(
      expect.objectContaining({ providerCustomerReference: CONTACT_ID })
    );
  });

  it("clears a pending row that the contact search matches exactly one contact", async () => {
    const existingContactId = "contact_existing_1";
    mockAccounts.getPendingCustomerLink.mockResolvedValue(pendingCustomerLinkRow());
    listContacts.mockResolvedValue([bvnkContact({ id: existingContactId })]);
    mockAccounts.completeCustomerLink.mockResolvedValue({
      ...pendingCustomerLinkRow(),
      provider_customer_reference: existingContactId,
      status: "active",
    });

    const result = await advanceBvnkContact(fakeContext(), {
      counterparty: counterpartyRow(),
      projectId: PROJECT_ID,
      collectedData: INDIVIDUAL_COLLECTED,
    });

    // Crash recovery: the single search match is adopted without creating a new contact.
    expect(result).toEqual({ contactId: existingContactId });
    expect(listContacts).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ q: COUNTERPARTY_ID, pageSize: 5 })
    );
    expect(createContact).not.toHaveBeenCalled();
    expect(mockAccounts.claimPendingCustomerLink).not.toHaveBeenCalled();
    expect(mockAccounts.completeCustomerLink).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "counterparty_provider_account_contact_claim",
        providerCustomerReference: existingContactId,
      })
    );
  });

  it("refuses to adopt when the contact search matches more than one contact", async () => {
    const duplicateIds = ["contact_dup_1", "contact_dup_2"];
    mockAccounts.getPendingCustomerLink.mockResolvedValue(pendingCustomerLinkRow());
    listContacts.mockResolvedValue(
      duplicateIds.map((id) => bvnkContact({ id, description: COUNTERPARTY_ID }))
    );

    let caught: unknown;
    try {
      await advanceBvnkContact(fakeContext(), {
        counterparty: counterpartyRow(),
        projectId: PROJECT_ID,
        collectedData: INDIVIDUAL_COLLECTED,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    const message = caught instanceof Error ? caught.message : String(caught);
    for (const id of duplicateIds) {
      expect(message).toContain(id);
    }
    expect(createContact).not.toHaveBeenCalled();
    expect(mockAccounts.completeCustomerLink).not.toHaveBeenCalled();
  });

  it("creates the contact when the contact search finds no match", async () => {
    mockAccounts.getPendingCustomerLink.mockResolvedValue(pendingCustomerLinkRow());
    listContacts.mockResolvedValue([]);
    createContact.mockResolvedValue(bvnkContact({ id: CONTACT_ID }));
    mockAccounts.completeCustomerLink.mockResolvedValue({
      ...pendingCustomerLinkRow(),
      provider_customer_reference: CONTACT_ID,
      status: "active",
    });

    const result = await advanceBvnkContact(fakeContext(), {
      counterparty: counterpartyRow(),
      projectId: PROJECT_ID,
      collectedData: INDIVIDUAL_COLLECTED,
    });

    expect(result).toEqual({ contactId: CONTACT_ID });
    expect(createContact).toHaveBeenCalledTimes(1);
    expect(mockAccounts.completeCustomerLink).toHaveBeenCalledWith(
      expect.objectContaining({ providerCustomerReference: CONTACT_ID })
    );
  });

  it("deletes the orphan contact and conflicts when a concurrent advance completes the row first", async () => {
    const deleteContact = vi.spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "deleteContactV3");
    const winnerContactId = "contact_race_winner";
    const orphanContactId = "contact_race_orphan";
    mockAccounts.getPendingCustomerLink.mockResolvedValue(pendingCustomerLinkRow());
    listContacts.mockResolvedValue([]);
    createContact
      .mockResolvedValueOnce(bvnkContact({ id: winnerContactId }))
      .mockResolvedValueOnce(bvnkContact({ id: orphanContactId }));
    mockAccounts.completeCustomerLink
      .mockResolvedValueOnce({
        ...pendingCustomerLinkRow(),
        provider_customer_reference: winnerContactId,
        status: "active",
      })
      .mockResolvedValueOnce(null);
    deleteContact.mockResolvedValue(undefined);

    const winner = await advanceBvnkContact(fakeContext(), {
      counterparty: counterpartyRow(),
      projectId: PROJECT_ID,
      collectedData: INDIVIDUAL_COLLECTED,
    });
    expect(winner).toEqual({ contactId: winnerContactId });

    let caught: unknown;
    try {
      await advanceBvnkContact(fakeContext(), {
        counterparty: counterpartyRow(),
        projectId: PROJECT_ID,
        collectedData: INDIVIDUAL_COLLECTED,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "CONFLICT",
      message: "A BVNK contact for this counterparty was created concurrently.",
    });
    expect(createContact).toHaveBeenCalledTimes(2);
    expect(deleteContact).toHaveBeenCalledTimes(1);
    expect(deleteContact).toHaveBeenCalledWith(expect.anything(), { contactId: orphanContactId });
  });
});

describe("bvnkContactFields", () => {
  it("collects DOB and the address block for an individual", () => {
    const fields = bvnkContactFields("individual");
    expect(fields.map((field) => field.key)).toEqual([
      "firstName",
      "lastName",
      "dateOfBirth",
      "address",
    ]);
    const address = fields.find(
      (field): field is Extract<RequirementField, { kind: "address" }> => field.kind === "address"
    );
    expect(address?.fields.map((part) => part.key)).toEqual([
      "address.addressLine1",
      "address.city",
      "address.postalCode",
      "address.country",
      "address.stateCode",
    ]);
    expect(address?.fields[0]).toMatchObject({
      kind: "text",
      key: "address.addressLine1",
      required: true,
    });
    expect(address?.fields[3]).toMatchObject({
      kind: "country",
      key: "address.country",
      required: true,
    });
    expect(address?.fields[4]).toMatchObject({
      kind: "text",
      key: "address.stateCode",
      required: false,
    });
  });

  it("collects the registration number and the address block for a company", () => {
    const fields = bvnkContactFields("business");
    expect(fields.map((field) => field.key)).toEqual([
      "legalName",
      "registrationNumber",
      "address",
    ]);
  });
});

describe("advanceBvnkContact US state rule", () => {
  let createContact: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    createContact = vi.spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "createContactV3");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects a US contact without a state code before any claim or provider call", async () => {
    mockAccounts.getPendingCustomerLink.mockResolvedValue(null);
    mockAccounts.claimPendingCustomerLink.mockResolvedValue(pendingCustomerLinkRow());

    let caught: unknown;
    try {
      await advanceBvnkContact(fakeContext(), {
        counterparty: counterpartyRow(),
        projectId: PROJECT_ID,
        collectedData: INDIVIDUAL_COLLECTED_NO_STATE,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: "BAD_REQUEST",
      message: "State is required for US BVNK contacts.",
    });
    expect(mockAccounts.claimPendingCustomerLink).not.toHaveBeenCalled();
    expect(createContact).not.toHaveBeenCalled();
  });

  it("omits the state code from the contact when the address country is not the US", async () => {
    mockAccounts.getPendingCustomerLink.mockResolvedValue(null);
    mockAccounts.claimPendingCustomerLink.mockResolvedValue(pendingCustomerLinkRow());
    createContact.mockResolvedValue(bvnkContact({ id: CONTACT_ID }));
    mockAccounts.completeCustomerLink.mockResolvedValue({
      ...pendingCustomerLinkRow(),
      provider_customer_reference: CONTACT_ID,
      status: "active",
    });

    await advanceBvnkContact(fakeContext(), {
      counterparty: counterpartyRow(),
      projectId: PROJECT_ID,
      collectedData: { ...INDIVIDUAL_COLLECTED_NO_STATE, "address.country": "GB" },
    });

    expect(createContact).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        entity: expect.objectContaining({
          address: {
            addressLine1: "1 Analytical Engine Way",
            city: "Austin",
            postalCode: "78701",
            country: "GB",
          },
        }),
      })
    );
  });
});

describe("ensureBvnkSettlementWallet", () => {
  let listLedgerWalletProfilesV2: ReturnType<typeof vi.spyOn>;
  let createLedgerWalletV2: ReturnType<typeof vi.spyOn>;

  /** A BVNK v2 ledger wallet owned by the settlement corridor's merchant profile. */
  function offrampLedgerWallet(status = "ACTIVE"): Record<string, unknown> {
    return {
      id: OFFRAMP_WALLET_ID,
      name: `sdp:offramp:${COUNTERPARTY_ID}:USD`,
      status,
      paymentInstruments: [],
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    listLedgerWalletProfilesV2 = vi.spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "listLedgerWalletProfilesV2");
    createLedgerWalletV2 = vi.spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "createLedgerWalletV2");
    listLedgerWalletProfilesV2.mockResolvedValue({
      content: [{ id: "profile_settlement_usd", currencies: ["USD"] }],
    } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("claims a pending settlement-wallet row, creates the BVNK wallet, and CASes the reference", async () => {
    mockAccounts.getVirtualSettlementWallet.mockResolvedValue(null);
    mockAccounts.insertPendingVirtualSettlementWallet.mockResolvedValue(
      settlementWalletRow({
        external_account_reference: null,
        provider_status: null,
        status: "pending",
      })
    );
    createLedgerWalletV2.mockResolvedValue(offrampLedgerWallet("PENDING"));
    mockAccounts.completeVirtualSettlementWalletReference.mockResolvedValue(
      settlementWalletRow({ provider_status: "PENDING", status: "pending" })
    );

    const result = await ensureBvnkSettlementWallet(
      fakeContext(),
      RAMP_CTX,
      counterpartyRow(),
      PROJECT_ID,
      "USD"
    );

    expect(result).toMatchObject({
      id: SETTLEMENT_ACCOUNT_ID,
      external_account_reference: OFFRAMP_WALLET_ID,
    });
    // The row is claimed before any BVNK call, so a crash after the wallet
    // create leaves a recoverable pending row tied to the same corridor.
    expect(
      mockAccounts.insertPendingVirtualSettlementWallet.mock.invocationCallOrder[0]
    ).toBeLessThan(createLedgerWalletV2.mock.invocationCallOrder[0]);
    expect(mockAccounts.insertPendingVirtualSettlementWallet).toHaveBeenCalledWith({
      organizationId: "org_test",
      projectId: PROJECT_ID,
      counterpartyId: COUNTERPARTY_ID,
      provider: "bvnk",
      fiatCurrency: "USD",
    });
    expect(listLedgerWalletProfilesV2).toHaveBeenCalledWith(expect.anything(), {
      currency: "USD",
    });
    // The BVNK wallet is created under the counterparty's display name and an
    // idempotency key derived from the claimed row id, so a retry reuses it.
    expect(createLedgerWalletV2).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        currency: "USD",
        name: buildBvnkOfframpWalletName(COUNTERPARTY_ID, "USD"),
        profileId: "profile_settlement_usd",
        idempotencyKey: expect.any(String),
      })
    );
    expect(mockAccounts.completeVirtualSettlementWalletReference).toHaveBeenCalledWith({
      organizationId: "org_test",
      projectId: PROJECT_ID,
      counterpartyId: COUNTERPARTY_ID,
      provider: "bvnk",
      id: SETTLEMENT_ACCOUNT_ID,
      externalAccountReference: OFFRAMP_WALLET_ID,
      providerStatus: "PENDING",
    });
  });

  it("completes an unbound settlement-wallet row left by a crash without inserting a second", async () => {
    mockAccounts.getVirtualSettlementWallet.mockResolvedValue(
      settlementWalletRow({
        external_account_reference: null,
        provider_status: null,
        status: "pending",
      })
    );
    createLedgerWalletV2.mockResolvedValue(offrampLedgerWallet("PENDING"));
    mockAccounts.completeVirtualSettlementWalletReference.mockResolvedValue(
      settlementWalletRow({ provider_status: "PENDING", status: "pending" })
    );

    const result = await ensureBvnkSettlementWallet(
      fakeContext(),
      RAMP_CTX,
      counterpartyRow(),
      PROJECT_ID,
      "USD"
    );

    // Crash recovery: the existing row is adopted, never duplicated.
    expect(result).toMatchObject({ id: SETTLEMENT_ACCOUNT_ID });
    expect(mockAccounts.insertPendingVirtualSettlementWallet).not.toHaveBeenCalled();
    expect(createLedgerWalletV2).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        currency: "USD",
        name: buildBvnkOfframpWalletName(COUNTERPARTY_ID, "USD"),
      })
    );
    expect(mockAccounts.completeVirtualSettlementWalletReference).toHaveBeenCalledWith(
      expect.objectContaining({
        id: SETTLEMENT_ACCOUNT_ID,
        externalAccountReference: OFFRAMP_WALLET_ID,
      })
    );
  });

  it("returns the bound settlement-wallet row without any provider call", async () => {
    mockAccounts.getVirtualSettlementWallet.mockResolvedValue(settlementWalletRow());

    const result = await ensureBvnkSettlementWallet(
      fakeContext(),
      RAMP_CTX,
      counterpartyRow(),
      PROJECT_ID,
      "USD"
    );

    expect(result).toMatchObject({
      id: SETTLEMENT_ACCOUNT_ID,
      external_account_reference: OFFRAMP_WALLET_ID,
      status: "active",
    });
    expect(listLedgerWalletProfilesV2).not.toHaveBeenCalled();
    expect(createLedgerWalletV2).not.toHaveBeenCalled();
    expect(mockAccounts.insertPendingVirtualSettlementWallet).not.toHaveBeenCalled();
    expect(mockAccounts.completeVirtualSettlementWalletReference).not.toHaveBeenCalled();
  });

  it("adopts the winning row after a unique-violation race on the settlement-wallet claim", async () => {
    mockAccounts.getVirtualSettlementWallet
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(settlementWalletRow());
    mockAccounts.insertPendingVirtualSettlementWallet.mockRejectedValue(uniqueViolationError());

    const result = await ensureBvnkSettlementWallet(
      fakeContext(),
      RAMP_CTX,
      counterpartyRow(),
      PROJECT_ID,
      "USD"
    );

    // The losing insert re-reads the corridor and adopts the winner's bound row.
    expect(result).toMatchObject({ id: SETTLEMENT_ACCOUNT_ID });
    expect(createLedgerWalletV2).not.toHaveBeenCalled();
    expect(mockAccounts.completeVirtualSettlementWalletReference).not.toHaveBeenCalled();
  });
});

describe("bvnkOnrampQuote", () => {
  let createOnrampRule: ReturnType<typeof vi.spyOn>;
  let listOnrampRulesByWallet: ReturnType<typeof vi.spyOn>;
  let deactivateOnrampRule: ReturnType<typeof vi.spyOn>;
  let getContactV3: ReturnType<typeof vi.spyOn>;
  let getLedgerWalletV2: ReturnType<typeof vi.spyOn>;
  let createLedgerWalletV2: ReturnType<typeof vi.spyOn>;
  let listLedgerWalletProfilesV2: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAccounts.getProviderAccount.mockResolvedValue(customerLinkRow());
    mockAccounts.getVirtualFundingWallet.mockResolvedValue(fundingWalletRow());
    mockPayments.createTransfer.mockResolvedValue(transferRow());
    mockPayments.getInFlightBvnkOnrampTransferByFundingWallet.mockResolvedValue(null);
    mockPayments.findInFlightTransferByBvnkRuleId.mockResolvedValue(null);
    mockPayments.bindBvnkOnrampRule.mockResolvedValue(transferRow());
    createOnrampRule = vi.spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "createOnrampRule");
    listOnrampRulesByWallet = vi.spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "listOnrampRulesByWallet");
    deactivateOnrampRule = vi.spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "deactivateOnrampRule");
    getContactV3 = vi.spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "getContactV3");
    getLedgerWalletV2 = vi.spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "getLedgerWalletV2");
    createLedgerWalletV2 = vi.spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "createLedgerWalletV2");
    listLedgerWalletProfilesV2 = vi.spyOn(RAMP_PROVIDER_CLIENTS.bvnk, "listLedgerWalletProfilesV2");
    listOnrampRulesByWallet.mockResolvedValue([]);
    getContactV3.mockResolvedValue(bvnkContact());
    getLedgerWalletV2.mockResolvedValue(bvnkLedgerWallet());
    createOnrampRule.mockResolvedValue({
      id: "rule_created_1",
      reference: buildBvnkOnrampRuleReference(TRANSFER_ID),
      status: "ACTIVE",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function expectConflictNamingActiveTransfer(caught: unknown, activeTransferId: string): void {
    expect(caught).toMatchObject({ code: "CONFLICT" });
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain(activeTransferId);
  }

  it("rejects a fiat outside the sandbox set before any repository or client work", async () => {
    let caught: unknown;
    try {
      await bvnkOnrampQuote(fakeContext(), onrampRequest({ fiatCurrency: "GBP" }));
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: "BAD_REQUEST" });
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain("does not support funding in GBP");
    expect(mockAccounts.getProviderAccount).not.toHaveBeenCalled();
    expect(mockPayments.createTransfer).not.toHaveBeenCalled();
    expect(listOnrampRulesByWallet).not.toHaveBeenCalled();
    expect(deactivateOnrampRule).not.toHaveBeenCalled();
    expect(createOnrampRule).not.toHaveBeenCalled();
    expect(getContactV3).not.toHaveBeenCalled();
    expect(getLedgerWalletV2).not.toHaveBeenCalled();
  });

  it("claims the transfer row awaiting_payment before any provider rule work", async () => {
    const result = await bvnkOnrampQuote(fakeContext(), onrampRequest());

    expect(mockPayments.createTransfer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: TRANSFER_ID,
        custodyWalletId: "cwlt_quote_destination",
        walletId: "wallet_quote_destination",
        destinationAddress: DESTINATION_WALLET_ADDRESS,
        type: "onramp",
        direction: "inbound",
        status: "awaiting_payment",
        provider: "bvnk",
        deliveryMode: "manual_instructions",
        fiatCurrency: "USD",
        fiatAmount: "100.00",
        providerData: { bvnk: { fundingWalletAccountId: FUNDING_ACCOUNT_ID } },
      })
    );
    // The per-transfer rule is created and CAS'd onto the transfer.
    expect(createOnrampRule).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        reference: buildBvnkOnrampRuleReference(TRANSFER_ID),
        walletId: WALLET_ID,
      })
    );
    expect(mockPayments.bindBvnkOnrampRule).toHaveBeenCalledWith(
      expect.objectContaining({ transferId: TRANSFER_ID, ruleId: "rule_created_1" })
    );
    expect(result.transferId).toBe(TRANSFER_ID);
  });

  it("maps a unique-index race on the second transfer insert to a 409 naming the active transfer", async () => {
    const firstTransferId = TRANSFER_ID;
    const racingTransferId = "xfr_aaaaaaaa-1111-2222-3333-444444444444";
    // Both quotes pass the in-flight pre-check; the unique index then decides
    // the INSERT, and the loser's catch lookup finds the winner.
    mockPayments.getInFlightBvnkOnrampTransferByFundingWallet
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(transferRow({ id: firstTransferId, ...BOUND_RULE_PROVIDER_DATA }));
    mockPayments.createTransfer
      .mockResolvedValueOnce(transferRow({ id: firstTransferId }))
      .mockRejectedValueOnce(uniqueViolationError());

    await bvnkOnrampQuote(fakeContext(), onrampRequest({ transferId: firstTransferId }));
    // Snapshot the first quote's provider work so the conflicted attempt can
    // be proven to add none of its own.
    const ruleWorkAfterFirstQuote = {
      list: listOnrampRulesByWallet.mock.calls.length,
      deactivate: deactivateOnrampRule.mock.calls.length,
      create: createOnrampRule.mock.calls.length,
      contact: getContactV3.mock.calls.length,
      bind: mockPayments.bindBvnkOnrampRule.mock.calls.length,
    };

    let caught: unknown;
    try {
      await bvnkOnrampQuote(fakeContext(), onrampRequest({ transferId: racingTransferId }));
    } catch (error) {
      caught = error;
    }
    // The losing insert maps to a 409 that names the transfer already holding
    // the queue slot — the active transfer, not the loser.
    expectConflictNamingActiveTransfer(caught, firstTransferId);
    // The winner already carries its rule, so the conflicted attempt performs
    // no rule management at all.
    expect(listOnrampRulesByWallet.mock.calls.length).toBe(ruleWorkAfterFirstQuote.list);
    expect(deactivateOnrampRule.mock.calls.length).toBe(ruleWorkAfterFirstQuote.deactivate);
    expect(createOnrampRule.mock.calls.length).toBe(ruleWorkAfterFirstQuote.create);
    expect(getContactV3.mock.calls.length).toBe(ruleWorkAfterFirstQuote.contact);
    expect(mockPayments.bindBvnkOnrampRule.mock.calls.length).toBe(ruleWorkAfterFirstQuote.bind);
  });

  it("rejects a second quote for a locked funding corridor before any BVNK call at all", async () => {
    const activeTransferId = "xfr_bbbbbbbb-1111-2222-3333-444444444444";
    mockPayments.getInFlightBvnkOnrampTransferByFundingWallet.mockResolvedValue(
      transferRow({ id: activeTransferId, ...BOUND_RULE_PROVIDER_DATA })
    );

    let caught: unknown;
    try {
      await bvnkOnrampQuote(
        fakeContext(),
        onrampRequest({
          transferId: "xfr_cccccccc-1111-2222-3333-444444444444",
          destinationWalletAddress: "8vBU6DHCv5K71VQcwvw8fHmRFJ5xgD7J6BpkMGRc2pw3",
        })
      );
    } catch (error) {
      caught = error;
    }

    expectConflictNamingActiveTransfer(caught, activeTransferId);
    // The pre-check lock fires before the JIT wallet refresh and any rule
    // listing, deactivation, creation, or binding.
    expect(mockPayments.createTransfer).not.toHaveBeenCalled();
    expect(getLedgerWalletV2).not.toHaveBeenCalled();
    expect(listLedgerWalletProfilesV2).not.toHaveBeenCalled();
    expect(createLedgerWalletV2).not.toHaveBeenCalled();
    expect(listOnrampRulesByWallet).not.toHaveBeenCalled();
    expect(deactivateOnrampRule).not.toHaveBeenCalled();
    expect(createOnrampRule).not.toHaveBeenCalled();
    expect(getContactV3).not.toHaveBeenCalled();
    expect(mockPayments.bindBvnkOnrampRule).not.toHaveBeenCalled();
  });

  it("repairs the lock holder's unbound rule before conflicting with the retried quote", async () => {
    const activeTransferId = "xfr_dddddddd-1111-2222-3333-444444444444";
    const holderRuleId = "rule_holder_recovered_1";
    // The holder crashed between rule create and CAS: the pre-check finds it
    // unbound, adopts the wallet's matching ACTIVE rule, then conflicts.
    mockPayments.getInFlightBvnkOnrampTransferByFundingWallet.mockResolvedValue(
      transferRow({ id: activeTransferId })
    );
    listOnrampRulesByWallet.mockResolvedValue([
      ruleEntry(holderRuleId, buildBvnkOnrampRuleReference(activeTransferId)),
    ]);

    let caught: unknown;
    try {
      await bvnkOnrampQuote(fakeContext(), onrampRequest());
    } catch (error) {
      caught = error;
    }

    expectConflictNamingActiveTransfer(caught, activeTransferId);
    expect(createOnrampRule).not.toHaveBeenCalled();
    expect(mockPayments.bindBvnkOnrampRule).toHaveBeenCalledWith(
      expect.objectContaining({ transferId: activeTransferId, ruleId: holderRuleId })
    );
  });

  it("adopts the wallet's single ACTIVE rule matching the transfer reference after a crash before the CAS", async () => {
    // The transfer exists without a rule (crash between rule create and CAS);
    // recovery lists the wallet's rules and adopts the one whose reference
    // equals sdp_onramp_<transfer id> instead of creating another rule.
    const recoveredRuleId = "rule_recovered_1";
    listOnrampRulesByWallet.mockResolvedValue([
      ruleEntry(recoveredRuleId, buildBvnkOnrampRuleReference(TRANSFER_ID)),
    ]);

    const result = await bvnkOnrampQuote(fakeContext(), onrampRequest());

    expect(createOnrampRule).not.toHaveBeenCalled();
    expect(getContactV3).not.toHaveBeenCalled();
    // The adopted rule is CAS'd onto the transfer with its BVNK status.
    expect(mockPayments.bindBvnkOnrampRule).toHaveBeenCalledWith(
      expect.objectContaining({
        transferId: TRANSFER_ID,
        ruleId: recoveredRuleId,
        ruleStatus: "ACTIVE",
      })
    );
    expect(result.transferId).toBe(TRANSFER_ID);
  });

  it("deactivates an ACTIVE stray rule that matches no in-flight transfer before creating its own", async () => {
    const freshRuleId = "rule_fresh_1";
    listOnrampRulesByWallet.mockResolvedValue([
      ruleEntry("rule_stray_1", "sdp_onramp_xfr_deadbeef-dead-beef-dead-beefdeadbeef"),
    ]);
    createOnrampRule.mockResolvedValue({
      id: freshRuleId,
      reference: buildBvnkOnrampRuleReference(TRANSFER_ID),
      status: "ACTIVE",
    });

    const result = await bvnkOnrampQuote(fakeContext(), onrampRequest());

    // Stray rules are deactivated first and never reused...
    expect(deactivateOnrampRule).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ruleId: "rule_stray_1" })
    );
    expect(deactivateOnrampRule.mock.invocationCallOrder[0]).toBeLessThan(
      createOnrampRule.mock.invocationCallOrder[0]
    );
    // ...then the transfer's own fresh rule is created with its reference and
    // CAS'd onto the transfer.
    expect(createOnrampRule).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        reference: buildBvnkOnrampRuleReference(TRANSFER_ID),
        walletId: WALLET_ID,
      })
    );
    expect(mockPayments.bindBvnkOnrampRule).toHaveBeenCalledWith(
      expect.objectContaining({ transferId: TRANSFER_ID, ruleId: freshRuleId })
    );
    expect(result.transferId).toBe(TRANSFER_ID);
  });

  it("refuses to pick a rule when several ACTIVE rules match the transfer reference", async () => {
    listOnrampRulesByWallet.mockResolvedValue([
      ruleEntry("rule_dup_1", buildBvnkOnrampRuleReference(TRANSFER_ID)),
      ruleEntry("rule_dup_2", buildBvnkOnrampRuleReference(TRANSFER_ID)),
    ]);

    let caught: unknown;
    try {
      await bvnkOnrampQuote(fakeContext(), onrampRequest());
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: "PROVIDER_UNAVAILABLE" });
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain("rule_dup_1");
    expect(message).toContain("rule_dup_2");
    expect(createOnrampRule).not.toHaveBeenCalled();
    expect(deactivateOnrampRule).not.toHaveBeenCalled();
    expect(mockPayments.bindBvnkOnrampRule).not.toHaveBeenCalled();
  });

  it("builds the manual-instructions quote from the wallet's payment instruments with the transfer id as the remittance reference", async () => {
    const result = await bvnkOnrampQuote(fakeContext(), onrampRequest());

    expect(result.quote.id.startsWith("bvnk_onramp_")).toBe(true);
    const instruction = result.quote.paymentInstructions.find(
      (item): item is Extract<typeof item, { kind: "fiat_funding" }> => item.kind === "fiat_funding"
    );
    expect(instruction?.fundingWalletId).toBe(WALLET_ID);
    expect(instruction?.bankAccount).toMatchObject({ accountNumber: "900473221558" });
    expect(instruction?.ruleId).toBe("rule_created_1");
    expect(JSON.stringify(instruction)).toContain(TRANSFER_ID);
  });

  it("refuses the quote until the funding wallet is active, creating no transfer", async () => {
    // A fresh wallet stays provisioning until the wallet-status webhook flips
    // it ACTIVE: while BVNK still reports PENDING, quoting fails closed.
    mockAccounts.getVirtualFundingWallet.mockResolvedValue(
      fundingWalletRow({ status: "pending", provider_status: "PENDING" })
    );
    getLedgerWalletV2.mockResolvedValue(bvnkLedgerWallet("PENDING"));

    let caught: unknown;
    try {
      await bvnkOnrampQuote(fakeContext(), onrampRequest());
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: "CONFLICT" });
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain("not provisioned for bvnk onramp");
    expect(mockPayments.createTransfer).not.toHaveBeenCalled();
    expect(createLedgerWalletV2).not.toHaveBeenCalled();
    expect(listLedgerWalletProfilesV2).not.toHaveBeenCalled();
    expect(listOnrampRulesByWallet).not.toHaveBeenCalled();
    expect(createOnrampRule).not.toHaveBeenCalled();
  });

  it("rejects a quote when the funding wallet row's provider status is not ACTIVE", async () => {
    mockAccounts.getVirtualFundingWallet.mockResolvedValue(
      fundingWalletRow({ provider_status: "INACTIVE" })
    );

    let caught: unknown;
    try {
      await bvnkOnrampQuote(fakeContext(), onrampRequest());
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: "CONFLICT" });
    expect(getLedgerWalletV2).not.toHaveBeenCalled();
    expect(mockPayments.createTransfer).not.toHaveBeenCalled();
    expect(createOnrampRule).not.toHaveBeenCalled();
  });

  it("marks the claimed transfer failed with the error when rule creation throws, freeing the funding lock", async () => {
    mockPayments.updateTransferStatusGuarded.mockResolvedValue(transferRow({ status: "failed" }));
    createOnrampRule.mockRejectedValueOnce(new Error("BVNK rule create exploded"));

    let caught: unknown;
    try {
      await bvnkOnrampQuote(fakeContext(), onrampRequest());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    // The row is CAS'd awaiting_payment → failed with the recorded error so the
    // funding-wallet lock frees immediately instead of waiting for the expiry cron.
    expect(mockPayments.updateTransferStatusGuarded).toHaveBeenCalledWith({
      transferId: TRANSFER_ID,
      organizationId: "org_test",
      projectId: PROJECT_ID,
      fromStatuses: ["awaiting_payment"],
      toStatus: "failed",
      error: "BVNK rule create exploded",
      updatedAt: expect.any(String),
    });

    // The failed row no longer holds the corridor, so a retried quote runs clean.
    mockPayments.createTransfer.mockClear();
    mockPayments.bindBvnkOnrampRule.mockClear();
    const next = await bvnkOnrampQuote(fakeContext(), onrampRequest());
    expect(next.transferId).toBe(TRANSFER_ID);
    expect(mockPayments.createTransfer).toHaveBeenCalledTimes(1);
    expect(mockPayments.bindBvnkOnrampRule).toHaveBeenCalledTimes(1);
  });
});
