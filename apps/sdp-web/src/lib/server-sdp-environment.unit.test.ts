import { beforeEach, describe, expect, it, vi } from "vitest";
import { isSelectedProjectSandbox } from "./server-sdp-environment";

const mocks = vi.hoisted(() => ({
  getSelectedProjectId: vi.fn(),
  listSdpProjects: vi.fn(),
}));

vi.mock("./sdp-api", () => mocks);

const projects = [
  { id: "sandbox-id", slug: "default-sandbox" },
  { id: "production-id", slug: "default-production" },
  { id: "preview-id", slug: "preview" },
];

describe("isSelectedProjectSandbox", () => {
  beforeEach(() => {
    mocks.listSdpProjects.mockResolvedValue(projects);
  });

  it("identifies the default sandbox", async () => {
    mocks.getSelectedProjectId.mockResolvedValue("sandbox-id");

    await expect(isSelectedProjectSandbox()).resolves.toBe(true);
  });

  it("identifies any non-production project as sandbox", async () => {
    mocks.getSelectedProjectId.mockResolvedValue("preview-id");

    await expect(isSelectedProjectSandbox()).resolves.toBe(true);
  });

  it("keeps the production project on live Markets paths", async () => {
    mocks.getSelectedProjectId.mockResolvedValue("production-id");

    await expect(isSelectedProjectSandbox()).resolves.toBe(false);
  });

  it("fails closed to the live path when project resolution fails", async () => {
    mocks.getSelectedProjectId.mockRejectedValue(new Error("unavailable"));

    await expect(isSelectedProjectSandbox()).resolves.toBe(false);
  });
});
