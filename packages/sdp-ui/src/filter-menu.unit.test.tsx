// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FilterMenu, FilterMenuOptions } from "./filter-menu";

function setViewport(width: number) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: width < 640,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

function ContactsFilters() {
  const [type, setType] = useState<string>();
  const [address, setAddress] = useState<string>();
  return (
    <FilterMenu
      label="Filter"
      searchPlaceholder="Filter by…"
      sections={[
        {
          id: "type",
          label: "Type",
          value: type,
          content: (
            <FilterMenuOptions
              value={type}
              anyLabel="Any type"
              options={[
                { value: "individual", label: "Individual" },
                { value: "business", label: "Business" },
              ]}
              onChange={setType}
            />
          ),
        },
        {
          id: "address",
          label: "Address",
          value: address,
          content: (
            <FilterMenuOptions
              value={address}
              anyLabel="Any address"
              options={[{ value: "without", label: "No address" }]}
              onChange={setAddress}
            />
          ),
        },
      ]}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Contacts filter menu at phone widths", () => {
  it.each([360, 390])(
    "keeps choices in one panel at %ipx and supports selecting and clearing",
    async (width) => {
      setViewport(width);
      const user = userEvent.setup();
      render(<ContactsFilters />);
      await user.click(screen.getByRole("button", { name: "Filter" }));
      expect(screen.getAllByRole("menu")).toHaveLength(1);
      await user.click(screen.getByRole("menuitemradio", { name: "Business" }));
      await user.click(await screen.findByRole("button", { name: /^Filter\s*1$/ }));
      expect(
        screen.getByRole("menuitemradio", { name: "Business" }).getAttribute("aria-checked")
      ).toBe("true");
      await user.click(screen.getByRole("menuitemradio", { name: "Any type" }));
      await user.click(await screen.findByRole("button", { name: "Filter" }));
      await user.type(screen.getByPlaceholderText("Filter by…"), "Address");
      expect(screen.queryByRole("menuitemradio", { name: "Business" })).toBeNull();
      await user.click(screen.getByRole("menuitemradio", { name: "No address" }));
      await user.click(await screen.findByRole("button", { name: /^Filter\s*1$/ }));
      expect(screen.getByRole("menuitemradio", { name: "Business" })).toBeTruthy();
      expect(
        screen.getByRole("menuitemradio", { name: "No address" }).getAttribute("aria-checked")
      ).toBe("true");
    }
  );

  it("keeps submenus at tablet widths", async () => {
    setViewport(768);
    const user = userEvent.setup();
    render(<ContactsFilters />);
    await user.click(screen.getByRole("button", { name: "Filter" }));
    expect(screen.queryByRole("menuitemradio", { name: "Business" })).toBeNull();
    await user.click(screen.getByRole("menuitem", { name: "Type" }));
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Business" }));
    expect(await screen.findByRole("button", { name: /^Filter\s*1$/ })).toBeTruthy();
  });
});
