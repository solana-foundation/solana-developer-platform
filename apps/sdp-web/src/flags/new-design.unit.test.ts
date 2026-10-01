import { afterEach, describe, expect, it, vi } from "vitest";
import { getDesignModuleFlags, withLegacyDesign } from "./new-design";

const flagMock = vi.hoisted(() => ({ on: true, contacts: true }));

vi.mock("@/flags", () => ({
  newDesign: async () => flagMock.on,
  newDesignContacts: async () => flagMock.contacts,
  newDesignPayDeposit: async () => true,
  newDesignActivity: async () => true,
  newDesignWallets: async () => true,
  newDesignIssuance: async () => true,
  newDesignOverview: async () => true,
}));

describe("withLegacyDesign", () => {
  afterEach(() => {
    flagMock.on = true;
    flagMock.contacts = true;
  });

  const page = withLegacyDesign(
    ({ id }: { id: string }) => `new ${id}`,
    async ({ id }: { id: string }) => `previous ${id}`
  );
  const contactsPage = withLegacyDesign(
    ({ id }: { id: string }) => `new ${id}`,
    async ({ id }: { id: string }) => `previous ${id}`,
    "contacts"
  );

  it("renders the new design's page when NEW DESIGN is on", async () => {
    await expect(page({ id: "a" })).resolves.toBe("new a");
  });

  it("renders the previous design's page when NEW DESIGN is off", async () => {
    flagMock.on = false;
    await expect(page({ id: "a" })).resolves.toBe("previous a");
  });

  it("renders a module's new page only while NEW DESIGN and the module's flag are both on", async () => {
    await expect(contactsPage({ id: "a" })).resolves.toBe("new a");
    flagMock.contacts = false;
    await expect(contactsPage({ id: "a" })).resolves.toBe("previous a");
    flagMock.contacts = true;
    flagMock.on = false;
    await expect(contactsPage({ id: "a" })).resolves.toBe("previous a");
  });
});

describe("getDesignModuleFlags", () => {
  it("evaluates every module's own flag", async () => {
    flagMock.contacts = false;
    await expect(getDesignModuleFlags()).resolves.toEqual({
      overview: true,
      wallets: true,
      issuance: true,
      contacts: false,
      payDeposit: true,
      activity: true,
    });
  });
});
