"use client";

import { type FormEvent, useState } from "react";
import { useTranslations } from "@/i18n/provider";

// During one form-submit validation pass the browser fires `invalid` on every
// invalid control synchronously, in DOM order. Cancelling each bubble (see
// onInvalid) also cancels the browser's native "focus the first invalid field"
// step, so we re-create it: the first field to fire claims focus for the pass,
// and the flag resets on a microtask — which runs after that synchronous burst.
let focusClaimedThisPass = false;

// Suppresses the browser's native validation bubble ("Please fill out this
// field", "Please match the requested format") and returns the message as a
// string so the caller can render it as styled inline text instead.
//
// Native constraint validation still runs and still blocks submission — we do
// NOT set `noValidate` — so this only changes HOW the message is shown, never
// whether invalid input is rejected. The message first appears when the browser
// fires `invalid` (i.e. on a submit attempt), then clears or updates live as the
// field is edited, so pristine fields stay error-free until the user submits.
export function useInlineValidationMessage(fieldLabel: string) {
  const t = useTranslations();
  const [message, setMessage] = useState<string | null>(null);

  const messageFor = (el: HTMLInputElement): string | null => {
    if (el.validity.valid) {
      return null;
    }
    if (el.validity.valueMissing) {
      return t("DashboardIssuance.errors.fieldRequired", { field: fieldLabel });
    }
    // patternMismatch: prefer the field's own title (e.g. "Enter a valid Solana
    // address") over the browser's generic "match the requested format" text.
    if (el.validity.patternMismatch && el.title) {
      return el.title;
    }
    return el.validationMessage;
  };

  const onInvalid = (event: FormEvent<HTMLInputElement>) => {
    event.preventDefault();
    setMessage(messageFor(event.currentTarget));
    // Re-create native focus-on-first-invalid: only the first invalid field of
    // this submit pass takes focus. Reset via a macrotask (setTimeout), NOT a
    // microtask — the browser flushes microtasks between the individual `invalid`
    // events in a pass, which would let each field re-claim focus (last-wins). A
    // macrotask runs only after the whole submit task, so the first field keeps it.
    if (!focusClaimedThisPass) {
      focusClaimedThisPass = true;
      event.currentTarget.focus();
      setTimeout(() => {
        focusClaimedThisPass = false;
      }, 0);
    }
  };

  // Re-check validity after an edit, but only while a message is already showing
  // so we never surface an error before the first submit attempt.
  const revalidate = (el: HTMLInputElement) => {
    setMessage((previous) => (previous === null ? null : messageFor(el)));
  };

  return { message, onInvalid, revalidate };
}
