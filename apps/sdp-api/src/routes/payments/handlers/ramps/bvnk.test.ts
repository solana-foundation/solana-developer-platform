import { RAMP_PROVIDER_CLIENTS } from "@sdp/payments/ramps";
import {
  type BvnkOnrampRequestSpec,
  buildBvnkOnrampPaymentRuleKey,
} from "@sdp/payments/ramps/providers/bvnk/provider-data";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CounterpartyRow } from "@/db/repositories/counterparty.repository";
import type { AppContext } from "../../context";
import { advanceBvnkContact, bvnkOnrampQuote } from "./bvnk";

const mockTransaction = vi.hoisted(() => ({}));

const mockAccounts = vi.hoisted(() => ({
  getPendingCustomerLink: vi.fn(),
  claimPendingCustomerLink: vi.fn(),
  completeCustomerLink: vi.fn(),
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

const COUNTERPARTY_ID = "cpty_123e4567-e89b-12d3-a456-426614174000";
const PROJECT_ID = "prj_test";
const CONTACT_ID = "contact_created_1";

function fakeContext(): AppContext {
  return {
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
 * advance's single transaction, bound by the CAS once the contact exists.
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

function counterpartyWithBvnkRule(ruleId: string): CounterpartyRow {
  const destinationWalletAddress = "J4t4M6zJH3M6ewN9pmRUpMt2EMWXXCFPYvnrD9ck9EEi";
  const paymentRuleKey = buildBvnkOnrampPaymentRuleKey(
    "USD",
    "USDC",
    "SOLANA",
    destinationWalletAddress
  );

  return {
    ...counterpartyRow(),
    display_name: "BVNK Test Counterparty",
    provider_data: {
      bvnk: {
        wallets: {
          [paymentRuleKey]: {
            walletId: "wallet_bvnk_123",
            walletStatus: "ACTIVE",
            ruleId,
            ruleStatus: "ACTIVE",
            bankAccount: { accountNumber: "000123456789", bankName: "BVNK Bank" },
          },
        },
      },
    },
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
      collectedData: { firstName: "Ada", lastName: "Lovelace" },
    });

    expect(result).toEqual({ contactId: CONTACT_ID });
    // The row is claimed exactly once and before any BVNK call, so a crash
    // after the provider call leaves a recoverable pending row.
    expect(mockAccounts.claimPendingCustomerLink).toHaveBeenCalledTimes(1);
    expect(
      mockAccounts.claimPendingCustomerLink.mock.invocationCallOrder[0]
    ).toBeLessThan(createContact.mock.invocationCallOrder[0]);
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
      collectedData: { legalName: "Acme Widgets Ltd" },
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
      collectedData: { firstName: "Ada", lastName: "Lovelace" },
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
        collectedData: { firstName: "Ada", lastName: "Lovelace" },
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
      collectedData: { firstName: "Ada", lastName: "Lovelace" },
    });

    expect(result).toEqual({ contactId: CONTACT_ID });
    expect(createContact).toHaveBeenCalledTimes(1);
    expect(mockAccounts.completeCustomerLink).toHaveBeenCalledWith(
      expect.objectContaining({ providerCustomerReference: CONTACT_ID })
    );
  });
});

describe("bvnkOnrampQuote", () => {
  it("uses a per-transaction quote id while keeping the BVNK payment rule id in instructions", async () => {
    const ruleId = "rule_bvnk_quote_123";
    const counterparty = counterpartyWithBvnkRule(ruleId);
    const input = {
      counterparty,
      paymentRule: {
        currency: "USDC",
        network: "SOLANA",
        fiatCurrency: "USD",
        destinationWalletAddress: "J4t4M6zJH3M6ewN9pmRUpMt2EMWXXCFPYvnrD9ck9EEi",
      } satisfies BvnkOnrampRequestSpec,
    };

    const first = await bvnkOnrampQuote(fakeContext(), input);
    const second = await bvnkOnrampQuote(fakeContext(), input);

    expect(first.quote.id).not.toBe(ruleId);
    expect(second.quote.id).not.toBe(ruleId);
    expect(second.quote.id).not.toBe(first.quote.id);
    expect(first.quote.id.startsWith("bvnk_onramp_")).toBe(true);

    const instruction = first.quote.paymentInstructions.find(
      (item) => item.kind === "fiat_funding"
    );
    expect(instruction?.ruleId).toBe(ruleId);
    expect(instruction?.fundingWalletId).toBe("wallet_bvnk_123");
    expect(first.transferProviderData).toEqual({
      bvnk: { ruleId, ruleStatus: "ACTIVE", fundingWalletId: "wallet_bvnk_123" },
    });
  });
});
