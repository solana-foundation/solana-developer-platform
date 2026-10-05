// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SearchInput } from "./search-input";

describe("SearchInput", () => {
  beforeEach(() => {
    cleanup();
  });

  it("is a labelled searchbox, falling back to the placeholder", () => {
    render(<SearchInput placeholder="Search integrations" />);

    const input = screen.getByRole("searchbox", { name: "Search integrations" });
    // ARIA role without type="search", so the browser's native clear affordance
    // never doubles the component's own X button.
    expect(input.getAttribute("type")).not.toBe("search");
  });

  it("shows a clear button only while the value is non-empty, and clears on it", () => {
    const onClear = vi.fn();
    const clear = { label: "Clear search", onClear };
    const { rerender } = render(
      <SearchInput placeholder="Search" value="" onChange={() => {}} clear={clear} />
    );
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();

    rerender(<SearchInput placeholder="Search" value="usd" onChange={() => {}} clear={clear} />);
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("clears on Escape while the value is non-empty", () => {
    const onClear = vi.fn();
    render(
      <SearchInput
        placeholder="Search"
        value="usd"
        onChange={() => {}}
        clear={{ label: "Clear search", onClear }}
      />
    );

    fireEvent.keyDown(screen.getByRole("searchbox", { name: "Search" }), { key: "Escape" });
    expect(onClear).toHaveBeenCalledTimes(1);
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
