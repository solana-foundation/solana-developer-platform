// The calls of the loop for one request, kept in this browser's storage, so that a refresh shows the
// same calls and continues from the last `progress`. A caller of the API keeps only that `progress`.

import type { Answer, ContinueBody } from "@/api";

export interface Call {
  route: "start" | "continue";
  body: unknown;
  answer: Answer | null;
  error: string | null;
}

const PREFIX = "intents-playground:loop:";

export function loadCalls(requestKey: string): Call[] {
  try {
    const saved = localStorage.getItem(PREFIX + requestKey);

    return saved === null ? [] : (JSON.parse(saved) as Call[]);
  } catch {
    return [];
  }
}

export function saveCalls(requestKey: string, calls: Call[]) {
  try {
    if (calls.length === 0) {
      localStorage.removeItem(PREFIX + requestKey);
    } else {
      localStorage.setItem(PREFIX + requestKey, JSON.stringify(calls));
    }
  } catch {
    // A page without storage still runs the loop. It only cannot resume after a refresh.
  }
}

/// What the caller did for the last `next`: the signatures of a `sign`, or the spend that its wallet
/// built for a `build`.
export interface Done {
  signatures: string[];
  built: Record<string, unknown> | null;
}

/// The body that continues from `answer`, with what the caller did for its `next`.
export function continueBody(answer: Answer, done: Done): ContinueBody {
  return {
    progress: answer.progress,
    ...(done.signatures.length > 0 ? { signatures: done.signatures } : {}),
    ...(done.built !== null ? { built: done.built } : {}),
  };
}
