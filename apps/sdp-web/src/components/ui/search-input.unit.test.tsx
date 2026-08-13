// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { SearchInput } from "./search-input";

describe("SearchInput", () => {
  beforeEach(() => {
    cleanup();
  });

  it("is a labelled searchbox, falling back to the placeholder", () => {
    render(<SearchInput placeholder="Search integrations" />);

    const input = screen.getByRole("searchbox", { name: "Search integrations" });
    expect(input.getAttribute("type")).toBe("search");
  });

  it("prefers an explicit aria-label over the placeholder", () => {
    render(<SearchInput placeholder="Search" aria-label="Search tokens" />);

    expect(screen.getByRole("searchbox", { name: "Search tokens" })).toBeTruthy();
  });

  it("only shows the pending spinner while a search is in flight", () => {
    const { container, rerender } = render(<SearchInput placeholder="Search" />);
    expect(container.querySelector(".animate-spin")).toBeNull();

    rerender(<SearchInput placeholder="Search" pending />);
    expect(container.querySelector(".animate-spin")).toBeTruthy();
  });
});
