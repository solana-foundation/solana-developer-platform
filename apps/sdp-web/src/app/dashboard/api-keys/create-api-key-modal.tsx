"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useEscapeKey } from "@/lib/use-escape-key";
import { Plus } from "lucide-react";
import { useState } from "react";
import { createApiKeyAction } from "./actions";

type ApiKeyRole = "api_admin" | "api_developer" | "api_readonly";
type ApiKeyEnvironment = "sandbox" | "production";

interface ApiKeyDraft {
  name: string;
  role: ApiKeyRole;
  environment: ApiKeyEnvironment;
  expiresAt: string;
}

function normalizeDraft(): ApiKeyDraft {
  return {
    name: "",
    role: "api_developer",
    environment: "sandbox",
    expiresAt: "",
  };
}

function formatDisplayDate(value: string): string {
  if (!value) return "None";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Invalid date";
  return date.toLocaleString();
}

interface CreateApiKeyModalProps {
  triggerMode?: "button" | "icon";
  triggerLabel?: string;
}

export function CreateApiKeyModal({
  triggerMode = "button",
  triggerLabel = "Create API key",
}: CreateApiKeyModalProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [step, setStep] = useState<1 | 2>(1);
  const [draft, setDraft] = useState<ApiKeyDraft>(normalizeDraft());

  const close = () => {
    setIsOpen(false);
    setStep(1);
    setDraft(normalizeDraft());
  };

  useEscapeKey(isOpen, close);

  const nextStep = () => {
    if (!draft.name.trim()) return;
    setStep(2);
  };

  return (
    <>
      <Button
        type="button"
        size={triggerMode === "icon" ? "icon" : "default"}
        variant={triggerMode === "icon" ? "secondary" : "default"}
        onClick={() => setIsOpen(true)}
        aria-label={triggerMode === "icon" ? "Create API key" : triggerLabel}
      >
        {triggerMode === "icon" ? (
          <>
            <Plus className="size-4" />
            <span className="sr-only">{triggerLabel}</span>
          </>
        ) : (
          triggerLabel
        )}
      </Button>

      {isOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4 py-8">
          <button
            type="button"
            aria-label="Close API key creation modal"
            className="absolute inset-0 bg-black/35"
            onClick={close}
          />
          <div className="relative z-10 w-full max-w-lg rounded-2xl border border-[rgba(28,28,29,0.16)] bg-white p-6 shadow-lg">
            <p className="text-sm font-semibold text-[#1c1c1d]">
              {step === 1 ? "Create API key" : "Review API key"}
            </p>
            <p className="mt-1 text-sm text-[rgba(28,28,29,0.72)]">
              {step === 1 ? "Define key details, then confirm." : "Review and confirm the request."}
            </p>

            {step === 1 ? (
              <div className="mt-4 space-y-4">
                <div className="grid gap-2">
                  <Label htmlFor="create-key-name">Name</Label>
                  <Input
                    id="create-key-name"
                    value={draft.name}
                    onChange={(event) => {
                      const name = event.currentTarget.value;
                      setDraft((previous) => ({ ...previous, name }));
                    }}
                    placeholder="CI deploy key"
                    required
                  />
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="create-key-role">Role</Label>
                  <select
                    id="create-key-role"
                    value={draft.role}
                    onChange={(event) => {
                      const role = event.currentTarget.value as ApiKeyRole;
                      setDraft((previous) => ({ ...previous, role }));
                    }}
                    className="h-10 w-full rounded-lg border border-[rgba(28,28,29,0.16)] bg-white px-3 text-sm text-[#1c1c1d]"
                  >
                    <option value="api_admin">Admin</option>
                    <option value="api_developer">Developer</option>
                    <option value="api_readonly">Read only</option>
                  </select>
                  <p className="text-xs text-[rgba(28,28,29,0.65)]">
                    Admin includes custody and platform-level privileges. Developer excludes custody
                    actions.
                  </p>
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="create-key-environment">Environment</Label>
                  <select
                    id="create-key-environment"
                    value={draft.environment}
                    onChange={(event) => {
                      const environment = event.currentTarget.value as ApiKeyEnvironment;
                      setDraft((previous) => ({ ...previous, environment }));
                    }}
                    className="h-10 w-full rounded-lg border border-[rgba(28,28,29,0.16)] bg-white px-3 text-sm text-[#1c1c1d]"
                  >
                    <option value="sandbox">Sandbox</option>
                    <option value="production">Production</option>
                  </select>
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="create-key-expires-at">Expiration (optional)</Label>
                  <Input
                    id="create-key-expires-at"
                    name="expiresAt"
                    type="datetime-local"
                    value={draft.expiresAt}
                    onChange={(event) => {
                      const expiresAt = event.currentTarget.value;
                      setDraft((previous) => ({ ...previous, expiresAt }));
                    }}
                  />
                </div>

                <div className="mt-2 flex items-center justify-end gap-2">
                  <Button type="button" variant="secondary" onClick={close}>
                    Cancel
                  </Button>
                  <Button type="button" disabled={!draft.name.trim()} onClick={nextStep}>
                    Continue
                  </Button>
                </div>
              </div>
            ) : (
              <form action={createApiKeyAction} className="mt-4 space-y-3">
                <input type="hidden" name="name" value={draft.name} />
                <input type="hidden" name="role" value={draft.role} />
                <input type="hidden" name="environment" value={draft.environment} />
                <input type="hidden" name="expiresAt" value={draft.expiresAt} />

                <div className="grid gap-2 rounded-lg border border-[rgba(28,28,29,0.12)] bg-[rgba(28,28,29,0.02)] p-3 text-sm text-[rgba(28,28,29,0.72)]">
                  <div>
                    <span className="font-medium text-[#1c1c1d]">Name:</span> {draft.name}
                  </div>
                  <div>
                    <span className="font-medium text-[#1c1c1d]">Role:</span> {draft.role}
                  </div>
                  <div>
                    <span className="font-medium text-[#1c1c1d]">Environment:</span>{" "}
                    {draft.environment}
                  </div>
                  <div>
                    <span className="font-medium text-[#1c1c1d]">Expires:</span>{" "}
                    {formatDisplayDate(draft.expiresAt)}
                  </div>
                </div>
                <p className="text-xs text-[rgba(28,28,29,0.72)]">
                  After creation, the full key will be shown once in a secure modal.
                </p>
                <div className="mt-3 flex items-center justify-end gap-2">
                  <Button type="button" variant="secondary" onClick={() => setStep(1)}>
                    Back
                  </Button>
                  <Button type="submit">Create key</Button>
                </div>
              </form>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
