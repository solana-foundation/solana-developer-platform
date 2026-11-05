import { expect } from "vitest";

/** Asserts a dashboard API response is uncacheable and keyed on the tab's Project. */
export function expectDashboardNoStore(response: Response): void {
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("Vary")).toBe("x-project-id");
}
