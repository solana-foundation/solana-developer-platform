// @vitest-environment jsdom

/**
 * Regression test for the stale-project Earn cache (APE-777, SOLA9-513).
 *
 * Proof statement: the production Earn position hook must never render a
 * sibling project's yield state in a tab that was rendered for another
 * project, even after another tab moves the shared `sdp_selected_project_id`
 * cookie and this tab revalidates. The BFF contract the hook drives refuses a
 * request whose declared rendered project differs from the cookie-resolved
 * request project; a request that declares no rendered project resolves from
 * the cookie alone, which is exactly the pre-fix behavior the exploit rode.
 *
 * The same-tab project switch is the negative control: remounting the SWR
 * provider on the new project scope must keep working and render the newly
 * selected project's data under its own label.
 */

import { createServer, type Server } from "node:http";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEarnVaultPositions } from "./earn-program-data";

const PROJECT_COOKIE = "sdp_selected_project_id";
const RENDERED_PROJECT_HEADER = "x-sdp-rendered-project-id";

const mocks = vi.hoisted(() => ({
  // The tab's rendered workspace state: React state that another tab's cookie
  // change does NOT touch.
  workspace: { selectedProjectId: "project-a" as string | null },
}));

vi.mock("@/contexts/dashboard-workspace-context", () => ({
  useOptionalDashboardWorkspace: () => mocks.workspace,
}));

function PositionsView({ selectedProjectId }: { selectedProjectId: string }) {
  const { positions, error, refresh } = useEarnVaultPositions();
  return (
    <section>
      <output aria-label="selected-project">{selectedProjectId}</output>
      <output aria-label="position-project">{positions?.[0]?.id ?? "loading"}</output>
      <output aria-label="position-error">{error ? "scope-refused" : "ok"}</output>
      <button type="button" onClick={refresh}>
        Revalidate
      </button>
    </section>
  );
}

/**
 * Mirrors the dashboard workspace provider: one SWR provider instance per
 * rendered project scope (`SWRConfig key={swrScopeKey}` remounts it).
 */
function ScopedView({ selectedProjectId }: { selectedProjectId: string }) {
  return (
    <SWRConfig key={selectedProjectId} value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <PositionsView selectedProjectId={selectedProjectId} />
    </SWRConfig>
  );
}

describe("Earn stale project scope", () => {
  let server: Server;
  let origin: string;
  let cookieProjectId = "project-a";

  beforeEach(async () => {
    const realFetch = globalThis.fetch;
    server = createServer((request, response) => {
      if (request.url !== "/api/dashboard/markets/earn/vault-positions?limit=100") {
        response.writeHead(404).end();
        return;
      }

      const cookie = request.headers.cookie ?? "";
      const cookieProject = cookie.match(new RegExp(`${PROJECT_COOKIE}=([^;]+)`))?.[1];
      if (!cookieProject) {
        response.writeHead(400).end(JSON.stringify({ error: "project cookie required" }));
        return;
      }

      // The BFF contract: a request that declares the project its tab rendered
      // with must agree with the cookie-resolved request project, or it is
      // refused; a request that declares nothing resolves from the cookie
      // alone (the pre-fix behavior this regression rides).
      const renderedProject = request.headers[RENDERED_PROJECT_HEADER];
      const resolvedProject =
        renderedProject && renderedProject !== cookieProject
          ? undefined
          : (renderedProject ?? cookieProject);
      if (!resolvedProject) {
        response.writeHead(409, { "content-type": "application/json" }).end(
          JSON.stringify({
            error: {
              code: "rendered_project_scope_mismatch",
              message: "Request project no longer matches the rendered project",
            },
          })
        );
        return;
      }

      response.setHeader("content-type", "application/json");
      response.writeHead(200).end(
        JSON.stringify({
          data: {
            positions: [
              {
                id: `${resolvedProject}-live-position`,
                provider: "kamino",
                providerReference: `${resolvedProject}-vault`,
                label: `${resolvedProject} position`,
                custodyWalletId: `${resolvedProject}-wallet`,
                tokenMint: "USDC",
                shareMint: `${resolvedProject}-share-mint`,
                createdAt: "2026-09-24T00:00:00.000Z",
                closedAt: null,
                feeSponsored: false,
                shares: "100",
                tokenValue: resolvedProject === "project-a" ? "101" : "202",
              },
            ],
            hasMore: false,
            nextCursor: null,
          },
        })
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("loopback server did not bind");
    origin = `http://127.0.0.1:${address.port}`;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const path = typeof input === "string" ? input : input.toString();
      return realFetch(new URL(path, origin), {
        ...init,
        headers: { ...(init?.headers ?? {}), Cookie: `${PROJECT_COOKIE}=${cookieProjectId}` },
      });
    }) as typeof fetch;
  });

  afterEach(async () => {
    cleanup();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  });

  it("never renders sibling-project data in an A-labelled tab after a cookie-only change", async () => {
    mocks.workspace.selectedProjectId = "project-a";
    const view = render(<ScopedView selectedProjectId="project-a" />);

    await waitFor(() =>
      expect(screen.getByLabelText("position-project").textContent).toBe("project-a-live-position")
    );

    // Another tab selects B. This tab's React state and SWR provider scope
    // remain A, but its next BFF request would otherwise follow the shared
    // cookie into B's data.
    cookieProjectId = "project-b";
    screen.getByRole("button", { name: "Revalidate" }).click();

    // The revalidation settles either in a refusal (the fixed behavior) or in
    // a successful sibling-project read (the exploit).
    await waitFor(() => {
      const error = screen.getByLabelText("position-error").textContent;
      const position = screen.getByLabelText("position-project").textContent;
      expect(error === "scope-refused" || position !== "project-a-live-position").toBe(true);
    });

    // Security assertion: whatever settled, the tab must never render the
    // sibling project's position under A's label.
    expect(screen.getByLabelText("position-project").textContent).not.toBe(
      "project-b-live-position"
    );
    expect(screen.getByLabelText("position-project").textContent).toBe("project-a-live-position");
    expect(screen.getByLabelText("selected-project").textContent).toBe("project-a");
    // The refused revalidation surfaces as an error, not as a silent success.
    expect(screen.getByLabelText("position-error").textContent).toBe("scope-refused");

    // Same-tab A -> B is the negative control: changing the provider scope
    // creates a fresh cache and the B-labelled tab renders B's response.
    mocks.workspace.selectedProjectId = "project-b";
    view.rerender(<ScopedView selectedProjectId="project-b" />);
    await waitFor(() =>
      expect(screen.getByLabelText("position-project").textContent).toBe("project-b-live-position")
    );
    expect(screen.getByLabelText("position-error").textContent).toBe("ok");
    expect(screen.getByLabelText("selected-project").textContent).toBe("project-b");
  });
});
