import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { resetDashboardNavigation, setDashboardUrl } from "@/test/dashboard-navigation";
import CounterpartyLoading from "./counterparty/loading";
import PaymentRequestsLoading from "./requests/loading";

vi.mock("next/navigation", () => import("@/test/next-navigation"));

const PAYMENTS = fileURLToPath(new URL(".", import.meta.url));

/** Every Payments route segment that renders a page, relative to the Payments root. */
const PAGE_SEGMENTS = readdirSync(PAYMENTS, { withFileTypes: true, recursive: true })
  .filter((entry) => entry.isFile() && entry.name === "page.tsx")
  .map((entry) => entry.parentPath.slice(PAYMENTS.length).replace(/\/$/, "") || ".")
  .sort();

const loadingModuleSchema = z.object({
  default: z.custom<() => ReactElement>((value) => typeof value === "function"),
});

describe("Payments route loading boundaries", () => {
  beforeEach(() => {
    resetDashboardNavigation();
  });

  it("finds the Payments pages it checks", () => {
    // An empty scan cannot tell "covered" from "scanned nothing".
    expect(PAGE_SEGMENTS).toContain(".");
    expect(PAGE_SEGMENTS.length).toBeGreaterThan(10);
  });

  it.each(PAGE_SEGMENTS)("%s shows a busy region while its page loads", async (segment) => {
    const loadingFile = `${PAYMENTS}${segment}/loading.tsx`;
    expect(existsSync(loadingFile), `${segment} has a loading.tsx`).toBe(true);

    const { default: Loading } = loadingModuleSchema.parse(await import(loadingFile));

    expect(renderToStaticMarkup(<Loading />)).toContain('aria-busy="true"');
  });

  it("loads Contacts and Requests as lists, whatever tab the URL carries", () => {
    setDashboardUrl("/dashboard/prj_test_sandbox/payments/counterparty?tab=playground", {});
    expect(renderToStaticMarkup(<CounterpartyLoading />)).toContain(
      'data-loading-layout="counterparty-directory"'
    );

    setDashboardUrl("/dashboard/prj_test_sandbox/payments/requests?tab=playground", {});
    expect(renderToStaticMarkup(<PaymentRequestsLoading />)).toContain(
      'data-loading-layout="payment-requests"'
    );
  });
});
