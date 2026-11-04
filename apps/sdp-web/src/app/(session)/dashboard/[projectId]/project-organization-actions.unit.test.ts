import { afterEach, describe, expect, it, vi } from "vitest";
import * as sdpApi from "@/lib/sdp-api";
import { OTHER_ORGANIZATION_PROJECT, PRODUCTION_PROJECT, SANDBOX_PROJECT } from "@/test/projects";
import { findProjectOrganization } from "./project-organization-actions";

const PROJECTS_BY_TOKEN = new Map([
  ["token_a", [SANDBOX_PROJECT, PRODUCTION_PROJECT]],
  ["token_b", [OTHER_ORGANIZATION_PROJECT]],
]);

function listByToken(refusals: Record<string, number> = {}) {
  return vi.spyOn(sdpApi, "listSdpProjectsForToken").mockImplementation(async (token) => {
    const status = refusals[token];
    if (status !== undefined) {
      throw new sdpApi.SdpApiResponseError(status, "refused");
    }
    const projects = PROJECTS_BY_TOKEN.get(token);
    if (projects === undefined) {
      throw new Error(`No test listing for ${token}`);
    }
    return projects;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("findProjectOrganization", () => {
  it("answers the index of the token whose organization lists the project", async () => {
    const list = listByToken();

    await expect(
      findProjectOrganization(OTHER_ORGANIZATION_PROJECT.id, ["token_a", "token_b"])
    ).resolves.toBe(1);
    expect(list.mock.calls).toEqual([["token_a"], ["token_b"]]);
  });

  it("answers null when no organization lists the project", async () => {
    listByToken();

    await expect(findProjectOrganization("prj_foreign", ["token_a", "token_b"])).resolves.toBe(
      null
    );
  });

  it.each([401, 403])(
    "treats an organization sdp-api refuses with %i as not listing it",
    async (status) => {
      listByToken({ token_a: status });

      await expect(
        findProjectOrganization(OTHER_ORGANIZATION_PROJECT.id, ["token_a", "token_b"])
      ).resolves.toBe(1);
    }
  );

  it("propagates any other failure", async () => {
    listByToken({ token_a: 503 });

    await expect(
      findProjectOrganization(OTHER_ORGANIZATION_PROJECT.id, ["token_a", "token_b"])
    ).rejects.toThrow("SDP API request failed (503): refused");
  });

  it("asks nothing without candidate organizations", async () => {
    const list = listByToken();

    await expect(findProjectOrganization(OTHER_ORGANIZATION_PROJECT.id, [])).resolves.toBe(null);
    expect(list).not.toHaveBeenCalled();
  });
});
