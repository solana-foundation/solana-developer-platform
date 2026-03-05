"use client";

import { Button } from "@/components/ui/button";
import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { rotateApiKeyAction } from "./actions";
import { DeleteApiKeyModal } from "./delete-api-key-modal";

interface ApiKeyActionsMenuProps {
  keyId: string;
  keyName: string;
  canRotate: boolean;
}

export function ApiKeyActionsMenu({ keyId, keyName, canRotate }: ApiKeyActionsMenuProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);

  return (
    <div className="relative inline-flex">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => setIsMenuOpen((open) => !open)}
      >
        Actions
        <ChevronDown className="h-4 w-4" />
      </Button>

      {isMenuOpen ? (
        <>
          <button
            type="button"
            aria-label="Close actions menu"
            className="fixed inset-0 z-20 cursor-default bg-transparent"
            onClick={() => setIsMenuOpen(false)}
          />
          <div className="absolute top-[42px] right-0 z-30 w-[200px] overflow-hidden rounded-xl border border-[rgba(28,28,29,0.12)] bg-white shadow-[0_14px_28px_rgba(28,28,29,0.16)]">
            <div className="p-1">
              {canRotate ? (
                <form action={rotateApiKeyAction}>
                  <input type="hidden" name="keyId" value={keyId} />
                  <input type="hidden" name="grace" value="24" />
                  <button
                    type="submit"
                    onClick={() => setIsMenuOpen(false)}
                    className="flex w-full items-center rounded-lg px-3 py-2 text-left text-sm hover:bg-[rgba(28,28,29,0.05)]"
                  >
                    Rotate key
                  </button>
                </form>
              ) : (
                <span className="flex w-full cursor-not-allowed items-center rounded-lg px-3 py-2 text-left text-sm text-[rgba(28,28,29,0.45)]">
                  Rotate key
                </span>
              )}

              <DeleteApiKeyModal
                keyId={keyId}
                keyName={keyName}
                renderTrigger={(open) => (
                  <button
                    type="button"
                    onClick={() => {
                      setIsMenuOpen(false);
                      open();
                    }}
                    className="flex w-full items-center rounded-lg px-3 py-2 text-left text-sm text-[#c71f37] hover:bg-[#c71f37]/10"
                  >
                    Delete key
                  </button>
                )}
              />
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
