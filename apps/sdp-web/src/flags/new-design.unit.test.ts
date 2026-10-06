import { afterEach, describe, expect, it, vi } from "vitest";
import { withLegacyDesign } from "./new-design";

const flagMock = vi.hoisted(() => ({ on: true }));

vi.mock("@/flags", () => ({ newDesign: async () => flagMock.on }));

describe("withLegacyDesign", () => {
  afterEach(() => {
    flagMock.on = true;
  });

  const page = withLegacyDesign(
    ({ id }: { id: string }) => `new ${id}`,
    async ({ id }: { id: string }) => `previous ${id}`
  );

  it("renders the new design's page when NEW DESIGN is on", async () => {
    await expect(page({ id: "a" })).resolves.toBe("new a");
  });

  it("renders the previous design's page when NEW DESIGN is off", async () => {
    flagMock.on = false;
    await expect(page({ id: "a" })).resolves.toBe("previous a");
  });
});
