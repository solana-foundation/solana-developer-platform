export const FEEDBACK_CATEGORIES = ["problem", "idea", "question"] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

/** The API's limit on the message (`FEEDBACK_MESSAGE_MAX_LENGTH` in sdp-api). */
export const FEEDBACK_MESSAGE_MAX_LENGTH = 5000;

export const FEEDBACK_FILE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
] as const;
const FEEDBACK_FILE_TYPE_SET: ReadonlySet<string> = new Set(FEEDBACK_FILE_TYPES);
export const FEEDBACK_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const FEEDBACK_FILES_MAX = 5;

export interface AttachedFile {
  key: string;
  file: File;
}

/** The category a segmented-control value names, or none for anything else. */
export function feedbackCategoryOf(value: string): FeedbackCategory | "" {
  return FEEDBACK_CATEGORIES.find((category) => category === value) ?? "";
}

/** Why a picked file was left out, naming it where the message does. */
export type FileRefusal =
  | { reason: "type"; name: string }
  | { reason: "size"; name: string }
  | { reason: "count" };

/**
 * Adds the picked files the screen takes, in order, and reports the last one it left out: not a
 * picture or a PDF, over 10 MB, or past the fifth file.
 */
export function addFeedbackFiles(
  attached: readonly AttachedFile[],
  picked: readonly File[]
): { files: AttachedFile[]; refusal: FileRefusal | null } {
  const files = [...attached];
  let refusal: FileRefusal | null = null;
  for (const file of picked) {
    if (!FEEDBACK_FILE_TYPE_SET.has(file.type)) {
      refusal = { reason: "type", name: file.name };
    } else if (file.size > FEEDBACK_FILE_MAX_BYTES) {
      refusal = { reason: "size", name: file.name };
    } else if (files.length >= FEEDBACK_FILES_MAX) {
      refusal = { reason: "count" };
    } else {
      files.push({ key: `${file.name}-${file.size}-${file.lastModified}`, file });
    }
  }
  return { files, refusal };
}

export function feedbackFileSize(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
