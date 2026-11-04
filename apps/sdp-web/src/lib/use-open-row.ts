import { useCallback, useState } from "react";

/**
 * One row of a list open at a time: whether a row is open, and the toggle that opens it, or
 * closes it when it already is. Opening another row closes the one before.
 */
export function useOpenRow(): {
  isOpen: (rowId: string) => boolean;
  toggle: (rowId: string) => void;
} {
  const [openRowId, setOpenRowId] = useState<string | null>(null);
  const isOpen = useCallback((rowId: string) => openRowId === rowId, [openRowId]);
  const toggle = useCallback(
    (rowId: string) => setOpenRowId((current) => (current === rowId ? null : rowId)),
    []
  );
  return { isOpen, toggle };
}
