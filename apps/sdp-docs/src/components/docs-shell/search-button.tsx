"use client";

import { useSearchContext } from "fumadocs-ui/contexts/search";
import { Search } from "lucide-react";

/** Opens the ⌘K search dialog, for a page that sends the reader to search. */
export function SearchButton({ className }: { className: string }) {
  const { setOpenSearch } = useSearchContext();
  return (
    <button type="button" className={className} onClick={() => setOpenSearch(true)}>
      <Search size={16} aria-hidden="true" />
      Search the docs
    </button>
  );
}
