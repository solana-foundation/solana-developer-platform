"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { deactivateApiKeyAction } from "./actions";

interface DeleteApiKeyModalProps {
  keyId: string;
  keyName: string;
}

export function DeleteApiKeyModal({ keyId, keyName }: DeleteApiKeyModalProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");

  const close = () => {
    setIsOpen(false);
    setConfirmation("");
  };

  const canSubmit = confirmation.trim() === keyName.trim();

  return (
    <>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="border-[#c71f37] text-[#c71f37] hover:bg-[#c71f37]/10"
        onClick={() => setIsOpen(true)}
      >
        Delete
      </Button>

      {isOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4 py-6">
          <button
            type="button"
            className="absolute inset-0 bg-black/30"
            aria-label="Close confirmation modal"
            onClick={close}
          />
          <div className="relative z-10 w-full max-w-md rounded-xl border border-[rgba(28,28,29,0.16)] bg-white p-5 shadow-lg">
            <p className="text-sm font-medium text-[#1c1c1d]">Delete API key</p>
            <p className="mt-2 text-sm text-[rgba(28,28,29,0.72)]">
              This removes the key without deleting the row.
            </p>
            <p className="mt-2 text-sm">
              Type <span className="font-mono font-medium">{keyName}</span> to confirm.
            </p>

            <form action={deactivateApiKeyAction} className="mt-4 space-y-3">
              <input type="hidden" name="keyId" value={keyId} />
              <input type="hidden" name="keyName" value={keyName} />
              <Label htmlFor={`confirm-${keyId}`} className="text-sm">
                Confirm key name
              </Label>
              <Input
                id={`confirm-${keyId}`}
                name="confirmation"
                value={confirmation}
                onChange={(event) => setConfirmation(event.currentTarget.value)}
                placeholder="Paste exact key name"
                autoFocus
                autoComplete="off"
              />

              <div className="mt-4 flex justify-end gap-2">
                <Button type="button" variant="secondary" onClick={close}>
                  Cancel
                </Button>
                <Button type="submit" variant="destructive" disabled={!canSubmit}>
                  Delete key
                </Button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}
