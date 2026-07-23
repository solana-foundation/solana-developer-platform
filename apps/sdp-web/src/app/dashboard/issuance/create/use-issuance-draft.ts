"use client";

import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { sanitizeAdvancedSettings } from "./draft-mapping";
import {
  coerceCapacities,
  createInitialDraft,
  type DraftState,
  furthestReachableStep,
  stepIndex,
  WIZARD_STEPS,
  type WizardStep,
} from "./issuance-draft-wizard.types";

const STORAGE_KEY = "sdp:issuance:create-draft:v1";
// Bump when the draft's meaning changes so stale drafts are discarded rather than
// hydrated into an inconsistent state. v2: advanced settings are combo-driven and
// reset per category, so pre-combo drafts (e.g. security extensions left on a
// generic asset) must not carry over.
const STORAGE_VERSION = 2;

interface WizardState {
  draft: DraftState;
  currentStep: WizardStep;
  maxStepReached: WizardStep;
  updatedAt: string | null;
}

type Action =
  | { type: "updateDraft"; patch: Partial<DraftState> }
  | { type: "goToStep"; step: WizardStep }
  | { type: "syncFromHistory"; step: WizardStep }
  | { type: "advance" }
  | { type: "goBack" }
  | { type: "reset" }
  | { type: "hydrate"; state: WizardState };

function createInitialState(): WizardState {
  return {
    draft: createInitialDraft(),
    currentStep: "classification",
    maxStepReached: "classification",
    updatedAt: null,
  };
}

function furthestOf(a: WizardStep, b: WizardStep): WizardStep {
  return stepIndex(a) >= stepIndex(b) ? a : b;
}

function reducer(state: WizardState, action: Action): WizardState {
  switch (action.type) {
    case "updateDraft": {
      const draft = { ...state.draft, ...action.patch };
      return { ...state, draft, updatedAt: new Date().toISOString() };
    }
    case "goToStep": {
      // Only allow navigating to a step already reached (e.g. an "Edit" from
      // Review).
      const target =
        stepIndex(action.step) <= stepIndex(state.maxStepReached)
          ? action.step
          : state.maxStepReached;
      return { ...state, currentStep: target };
    }
    case "syncFromHistory": {
      // Mirrors goToStep's ceiling — never land past what's actually been
      // reached — so browser back/forward can only move within visited steps.
      const target =
        stepIndex(action.step) <= stepIndex(state.maxStepReached)
          ? action.step
          : state.maxStepReached;
      return { ...state, currentStep: target };
    }
    case "advance": {
      const nextIndex = Math.min(stepIndex(state.currentStep) + 1, WIZARD_STEPS.length - 1);
      const nextStep = WIZARD_STEPS[nextIndex];
      return {
        ...state,
        currentStep: nextStep,
        maxStepReached: furthestOf(state.maxStepReached, nextStep),
      };
    }
    case "goBack": {
      const prevIndex = Math.max(stepIndex(state.currentStep) - 1, 0);
      const prevStep = WIZARD_STEPS[prevIndex];
      return { ...state, currentStep: prevStep };
    }
    case "reset":
      return createInitialState();
    case "hydrate":
      return action.state;
    default:
      return state;
  }
}

function isWizardStep(value: unknown): value is WizardStep {
  return typeof value === "string" && (WIZARD_STEPS as readonly string[]).includes(value);
}

// Tags each history entry the wizard pushes with the step it represents, so a
// `popstate` (browser back/forward) can be told apart from any other page's
// history entries — the URL itself never changes, only this state marker.
interface HistoryStepState {
  __issuanceWizardStep: true;
  step: WizardStep;
}

function isHistoryStepState(value: unknown): value is HistoryStepState {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __issuanceWizardStep?: unknown }).__issuanceWizardStep === true
  );
}

// Parse + validate a persisted payload, clamping the restored step to what the
// restored draft actually supports so a stale entry can't land the user on a
// step whose prerequisites are unmet.
function readStoredState(): WizardState | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as {
      version?: number;
      draft?: Partial<DraftState>;
      currentStep?: unknown;
      maxStepReached?: unknown;
      updatedAt?: unknown;
    };
    if (parsed.version !== STORAGE_VERSION || typeof parsed.draft !== "object" || !parsed.draft) {
      return null;
    }

    const draft: DraftState = { ...createInitialDraft(), ...parsed.draft };
    // Re-validate persisted advanced settings against the current rules so stale
    // storage can't restore a now-invalid combination (e.g. two conflicting
    // extensions both left checked before conflict validation existed).
    draft.advancedSettings = sanitizeAdvancedSettings(
      draft.assetCategory,
      draft.assetType,
      draft.advancedSettings
    );
    // Normalize capacities: a pre-config-layer draft stored them as bare booleans,
    // which would reach the toggle as `undefined` .enabled (uncontrolled input).
    draft.capacities = coerceCapacities(parsed.draft.capacities);
    const ceiling = furthestReachableStep(draft);
    const storedCurrent = isWizardStep(parsed.currentStep) ? parsed.currentStep : "classification";
    const storedMax = isWizardStep(parsed.maxStepReached) ? parsed.maxStepReached : storedCurrent;

    const clamp = (step: WizardStep): WizardStep =>
      stepIndex(step) <= stepIndex(ceiling) ? step : ceiling;

    return {
      draft,
      currentStep: clamp(storedCurrent),
      maxStepReached: clamp(furthestOf(storedMax, storedCurrent)),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
    };
  } catch {
    return null;
  }
}

function writeStoredState(state: WizardState): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: STORAGE_VERSION, ...state })
    );
  } catch {
    // Storage full / unavailable (private mode) — persistence is best-effort.
  }
}

function clearStoredState(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export interface IssuanceDraftContextValue {
  draft: DraftState;
  currentStep: WizardStep;
  maxStepReached: WizardStep;
  updatedAt: string | null;
  updateDraft: (patch: Partial<DraftState>) => void;
  goToStep: (step: WizardStep) => void;
  advance: () => void;
  goBack: () => void;
  reset: () => void;
  // Clear the persisted draft without touching the in-memory wizard state, so a
  // successful submit can wipe storage while keeping the current step on screen
  // (the wizard unmounts on navigation, so its state is discarded anyway).
  clearStoredDraft: () => void;
}

const IssuanceDraftContext = createContext<IssuanceDraftContextValue | null>(null);

export function IssuanceDraftProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, createInitialState);
  // `hydrated` is state (not a ref) so the persist effect below reads `false`
  // on the first commit and skips writing defaults over a stored draft.
  const [hydrated, setHydrated] = useState(false);
  // Has the entry the page loaded on been tagged with its step yet? Gates the
  // history effect below between "tag the current entry" (replaceState, on
  // first run) and "push a new entry" (on every subsequent step change).
  const didTagInitialEntryRef = useRef(false);
  // Set right before a popstate-driven dispatch, or before reset() — tells
  // the history effect below to skip its next push, since history already
  // reflects the change (or we're intentionally leaving the wizard).
  const suppressNextPushRef = useRef(false);

  // Hydrate once, after mount (SSR-safe — the first client render matches the
  // server's default output, then we restore from localStorage).
  useEffect(() => {
    const stored = readStoredState();
    if (stored) {
      dispatch({ type: "hydrate", state: stored });
    }
    setHydrated(true);
  }, []);

  // Persist every change once hydration has run.
  useEffect(() => {
    if (!hydrated) {
      return;
    }
    writeStoredState(state);
  }, [state, hydrated]);

  // Keep the browser history stack in sync with the wizard step, using the
  // same URL throughout (no query string/deep-linking involved) — this is
  // what makes the browser Back button step back through the wizard instead
  // of leaving it outright.
  useEffect(() => {
    if (!hydrated || typeof window === "undefined") {
      return;
    }
    const historyState: HistoryStepState = {
      __issuanceWizardStep: true,
      step: state.currentStep,
    };
    if (!didTagInitialEntryRef.current) {
      window.history.replaceState(historyState, "");
      didTagInitialEntryRef.current = true;
      return;
    }
    if (suppressNextPushRef.current) {
      suppressNextPushRef.current = false;
      return;
    }
    window.history.pushState(historyState, "");
  }, [state.currentStep, hydrated]);

  // Follow the browser Back/Forward buttons: when they land on one of our
  // tagged entries, sync the reducer to match instead of letting the
  // browser navigate away from the wizard entirely.
  useEffect(() => {
    function handlePopState(event: PopStateEvent) {
      if (!isHistoryStepState(event.state)) {
        return;
      }
      suppressNextPushRef.current = true;
      dispatch({ type: "syncFromHistory", step: event.state.step });
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const value = useMemo<IssuanceDraftContextValue>(
    () => ({
      draft: state.draft,
      currentStep: state.currentStep,
      maxStepReached: state.maxStepReached,
      updatedAt: state.updatedAt,
      updateDraft: (patch) => dispatch({ type: "updateDraft", patch }),
      goToStep: (step) => dispatch({ type: "goToStep", step }),
      advance: () => dispatch({ type: "advance" }),
      goBack: () => dispatch({ type: "goBack" }),
      reset: () => {
        clearStoredState();
        suppressNextPushRef.current = true;
        dispatch({ type: "reset" });
      },
      clearStoredDraft: () => clearStoredState(),
    }),
    [state]
  );

  return createElement(IssuanceDraftContext.Provider, { value }, children);
}

export function useIssuanceDraft(): IssuanceDraftContextValue {
  const value = useContext(IssuanceDraftContext);
  if (!value) {
    throw new Error("useIssuanceDraft must be used within an IssuanceDraftProvider");
  }
  return value;
}
