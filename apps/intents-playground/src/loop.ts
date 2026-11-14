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

/// The body that continues from `answer`, with the signatures of its `sign`, when there are some.
export function continueBody(answer: Answer, signatures: string[]): ContinueBody {
  return signatures.length === 0
    ? { progress: answer.progress }
    : { progress: answer.progress, signatures };
}
