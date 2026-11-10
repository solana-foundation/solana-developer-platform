"use client";

import { useUser } from "@clerk/nextjs";
import { Button } from "@sdp/ui/button";
import { SegmentedControl } from "@sdp/ui/segmented-control";
import { Textarea } from "@sdp/ui/textarea";
import * as Sentry from "@sentry/nextjs";
import { FileTextIcon, ImageIcon, PaperclipIcon, SendIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { type ChangeEvent, useId, useRef, useState, useTransition } from "react";
import { z } from "zod";
import type { MessageKey } from "@/i18n/messages";
import { useTranslations } from "@/i18n/provider";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import { useProjectHref } from "@/lib/use-dashboard-project";
import { useZodForm } from "@/lib/use-zod-form";
import {
  type AttachedFile,
  addFeedbackFiles,
  FEEDBACK_CATEGORIES,
  FEEDBACK_FILE_TYPES,
  FEEDBACK_FILES_MAX,
  FEEDBACK_MESSAGE_MAX_LENGTH,
  type FeedbackCategory,
  type FileRefusal,
  feedbackCategoryOf,
  feedbackFileSize,
} from "./feedback-files";

const CATEGORY_LABEL_KEYS = {
  problem: "Feedback.categoryProblem",
  idea: "Feedback.categoryIdea",
  question: "Feedback.categoryQuestion",
} as const satisfies Record<FeedbackCategory, MessageKey>;

const HOME_HREF = "/dashboard";
const MESSAGE_TOO_LONG = "Feedback.messageTooLong";

/** What is sent: an optional category and the message, within the API's limit. */
const FEEDBACK_SCHEMA = z.object({
  category: z.union([z.enum(FEEDBACK_CATEGORIES), z.literal("")]),
  message: z.string().trim().min(1).max(FEEDBACK_MESSAGE_MAX_LENGTH, MESSAGE_TOO_LONG),
});

type Translate = ReturnType<typeof useTranslations>;

function refusalMessage(refusal: FileRefusal, t: Translate): string {
  switch (refusal.reason) {
    case "type":
      return t("Feedback.attachWrongType", { name: refusal.name });
    case "size":
      return t("Feedback.attachTooLarge", { name: refusal.name });
    case "count":
      return t("Feedback.attachTooMany", { max: String(FEEDBACK_FILES_MAX) });
    default: {
      const exhaustive: never = refusal;
      throw new Error(`Unhandled file refusal: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * The dashboard's Send feedback screen (PRO-2421, Hoodies' `/feedback`): what it is about, what
 * the person would change, and up to five screenshots or PDFs. The words go to the SDP team's
 * inbox through the API, replying to the sender; the files and the session replay go to Sentry,
 * whose event id the email carries. Without Sentry there is nowhere to keep files, so the screen
 * takes none.
 */
export function FeedbackForm({
  organizationId,
  fromPath,
}: {
  organizationId: string;
  /** The dashboard page the person opened the screen from, when the link carried it. */
  fromPath: string | null;
}) {
  const t = useTranslations();
  const projectHref = useProjectHref();
  const messageId = useId();
  const form = useZodForm(FEEDBACK_SCHEMA, { category: "", message: "" }, (message) =>
    message === MESSAGE_TOO_LONG ? t(MESSAGE_TOO_LONG) : message
  );
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ files: number; withPage: boolean } | null>(null);
  const [sending, startSend] = useTransition();
  // A retry after a failed send names the Sentry event the first try made, while what it
  // holds is unchanged, instead of uploading the files again as a second event.
  const sentryEvent = useRef<{ signature: string; eventId: string } | null>(null);
  const homeHref = projectHref(HOME_HREF);
  const takesFiles = Sentry.getClient() !== undefined;

  const pickFiles = (picked: File[]) => {
    const added = addFeedbackFiles(files, picked);
    setFiles(added.files);
    setFileError(added.refusal ? refusalMessage(added.refusal, t) : null);
  };

  const submit = () => {
    if (sending) return;
    const parsed = form.validate();
    if (!parsed.ok) return;
    setSendError(null);
    const pageUrl = feedbackPageUrl(fromPath);
    startSend(async () => {
      const result = await sendFeedback(
        {
          organizationId,
          category: parsed.data.category,
          message: parsed.data.message,
          pageUrl,
          files,
        },
        sentryEvent
      );
      if (result.kind === "sent") setSent({ files: files.length, withPage: pageUrl !== undefined });
      else setSendError(sendErrorText(result, t));
    });
  };

  if (sent !== null) return <FeedbackSent {...sent} homeHref={homeHref} />;

  return (
    <form
      className="flex flex-col gap-6"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="flex flex-col gap-2">
        <span className="text-field font-medium text-primary">{t("Feedback.categoryLabel")}</span>
        <SegmentedControl
          ariaLabel={t("Feedback.categoryLabel")}
          className="self-start"
          optionClassName="px-4 py-1.5 text-body"
          options={FEEDBACK_CATEGORIES.map((value) => ({
            value,
            label: t(CATEGORY_LABEL_KEYS[value]),
          }))}
          value={form.values.category}
          onChange={(value) => form.setField("category", feedbackCategoryOf(value))}
          disabled={sending}
        />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor={messageId} className="text-field font-medium text-primary">
          {t("Feedback.messageLabel")}
        </label>
        {/* biome-ignore lint/a11y/noAutofocus: the screen exists to take this one field. */}
        <Textarea
          id={messageId}
          autoFocus
          rows={6}
          value={form.values.message}
          onChange={(event) => form.setField("message", event.target.value)}
          placeholder={t("Feedback.messagePlaceholder")}
          disabled={sending}
          aria-invalid={form.errors.message ? true : undefined}
          aria-describedby={form.errors.message ? `${messageId}-error` : undefined}
          className="resize-y text-body"
        />
        {form.errors.message ? (
          <p id={`${messageId}-error`} className="text-meta text-error">
            {form.errors.message}
          </p>
        ) : null}
      </div>

      <AttachedFileList
        files={files}
        disabled={sending}
        onRemove={(key) => {
          setFiles(files.filter((entry) => entry.key !== key));
          setFileError(null);
          setSendError(null);
        }}
      />

      <div className="-mt-2 flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {takesFiles ? (
            <AttachControl
              disabled={sending || files.length >= FEEDBACK_FILES_MAX}
              onPick={pickFiles}
            />
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            {sending ? (
              <Button type="button" variant="ghost" disabled>
                {t("Feedback.cancel")}
              </Button>
            ) : (
              <Button asChild variant="ghost">
                <Link href={homeHref}>{t("Feedback.cancel")}</Link>
              </Button>
            )}
            <Button
              type="submit"
              loading={sending}
              disabled={!form.values.message.trim()}
              iconLeft={<SendIcon aria-hidden="true" />}
            >
              {t("Feedback.submit")}
            </Button>
          </div>
        </div>
        {fileError ? (
          <p className="text-meta text-error" role="alert">
            {fileError}
          </p>
        ) : null}
        {sendError ? (
          <p className="text-meta text-secondary" role="alert">
            {sendError}
          </p>
        ) : null}
      </div>
    </form>
  );
}

const SEND_RESULT_SCHEMA = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("sent") }),
  z.object({ kind: z.literal("unreadable"), name: z.string() }),
  z.object({ kind: z.literal("filesRefused") }),
  z.object({ kind: z.literal("unavailable") }),
  z.object({ kind: z.literal("failed"), error: z.string() }),
]);
type SendResult = z.infer<typeof SEND_RESULT_SCHEMA>;

function sendErrorText(result: Exclude<SendResult, { kind: "sent" }>, t: Translate): string {
  switch (result.kind) {
    case "unreadable":
      return t("Feedback.attachUnreadable", { name: result.name });
    case "filesRefused":
      return t("Feedback.attachUploadFailed");
    case "unavailable":
      return t("Feedback.unavailable");
    case "failed":
      return t("Feedback.submitFailed", { error: result.error });
    default: {
      const exhaustive: never = result;
      throw new Error(`Unhandled feedback result: ${JSON.stringify(exhaustive)}`);
    }
  }
}

const READ_RESULT_SCHEMA = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    attachment: z.object({
      filename: z.string(),
      data: z.instanceof(Uint8Array),
      contentType: z.string(),
    }),
  }),
  z.object({ ok: z.literal(false), name: z.string() }),
]);
type ReadResult = z.infer<typeof READ_RESULT_SCHEMA>;

const ATTACHMENTS_RESULT_SCHEMA = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    attachments: z.array(READ_RESULT_SCHEMA.options[0].shape.attachment),
  }),
  READ_RESULT_SCHEMA.options[1],
]);
type AttachmentsResult = z.infer<typeof ATTACHMENTS_RESULT_SCHEMA>;

async function readAttachment(file: File): Promise<ReadResult> {
  try {
    const data = new Uint8Array(await file.arrayBuffer());
    return { ok: true, attachment: { filename: file.name, data, contentType: file.type } };
  } catch {
    return { ok: false, name: file.name };
  }
}

/**
 * Reads the attached files together (five at most, all local); a file that can no longer be read
 * is named, and nothing is sent.
 */
async function readAttachments(files: readonly AttachedFile[]): Promise<AttachmentsResult> {
  const read = await Promise.all(files.map(({ file }) => readAttachment(file)));
  const attachments = [];
  for (const entry of read) {
    if (!entry.ok) return entry;
    attachments.push(entry.attachment);
  }
  return { ok: true, attachments };
}

/** The full address of the page the person came from, on this dashboard's own origin. */
function feedbackPageUrl(fromPath: string | null): string | undefined {
  if (fromPath === null) return undefined;
  const url = new URL(fromPath, window.location.origin);
  return url.origin === window.location.origin ? url.href : undefined;
}

interface FeedbackInput {
  organizationId: string;
  category: FeedbackCategory | "";
  message: string;
  pageUrl: string | undefined;
  files: readonly AttachedFile[];
}

/** What a Sentry event holds, so a retry can tell whether the last one still matches. */
function sentrySignature(input: FeedbackInput): string {
  return JSON.stringify([
    input.category,
    input.message,
    input.pageUrl ?? null,
    input.files.map((entry) => entry.key),
  ]);
}

/**
 * Records the feedback in Sentry and waits for Sentry to accept it: `captureFeedback` returns an
 * id before the upload runs, so only an accepted upload names an event the files are on. The
 * tags go on a scope of their own, since `sendFeedback` sets them on the scope it runs in.
 */
async function uploadToSentry(
  input: FeedbackInput,
  attachments: Extract<AttachmentsResult, { ok: true }>["attachments"]
): Promise<string | null> {
  try {
    return await Sentry.withScope(() =>
      Sentry.sendFeedback(
        {
          message: input.message,
          source: "dashboard",
          url: input.pageUrl,
          tags: input.category ? { feedback_category: input.category } : undefined,
        },
        { includeReplay: true, attachments }
      )
    );
  } catch {
    return null;
  }
}

/**
 * Files and the replay go to Sentry first, when the deployment runs it, so the email can name
 * the event that holds them; the words then go to the SDP team's inbox through the API. Files
 * Sentry refuses stop the send, so the team never gets an email naming files it cannot find;
 * without files the email goes anyway, naming no event. A retry of the same feedback reuses an
 * event Sentry accepted.
 */
async function sendFeedback(
  input: FeedbackInput,
  sentryEvent: { current: { signature: string; eventId: string } | null }
): Promise<SendResult> {
  let sentryEventId: string | undefined;
  // Files and the replay have somewhere to go only while the deployment runs Sentry.
  if (Sentry.getClient() !== undefined) {
    const signature = sentrySignature(input);
    if (sentryEvent.current?.signature === signature) {
      sentryEventId = sentryEvent.current.eventId;
    } else {
      const read = await readAttachments(input.files);
      if (!read.ok) return { kind: "unreadable", name: read.name };
      const accepted = await uploadToSentry(input, read.attachments);
      if (accepted === null && input.files.length > 0) return { kind: "filesRefused" };
      if (accepted !== null) {
        sentryEventId = accepted;
        sentryEvent.current = { signature, eventId: accepted };
      }
    }
  }
  const result = await dashboardFetch<unknown>(
    `/api/dashboard/organizations/${encodeURIComponent(input.organizationId)}/feedback`,
    {
      method: "POST",
      body: {
        category: input.category || undefined,
        message: input.message,
        pageUrl: input.pageUrl,
        attachmentCount: input.files.length,
        sentryEventId,
      },
    }
  );
  if (result.ok) return { kind: "sent" };
  if (result.status === 503 || result.status === null) return { kind: "unavailable" };
  return { kind: "failed", error: result.error };
}

/** What went with the words: the page they came from, when known, and the files. */
function sentWithText(withPage: boolean, files: number, t: Translate): string | null {
  const count = String(files);
  if (withPage) {
    if (files === 0) return t("Feedback.sentPage");
    if (files === 1) return t("Feedback.sentPageOneFile");
    return t("Feedback.sentPageFiles", { count });
  }
  if (files === 0) return null;
  if (files === 1) return t("Feedback.sentOneFile");
  return t("Feedback.sentFiles", { count });
}

function FeedbackSent({
  files,
  withPage,
  homeHref,
}: {
  files: number;
  withPage: boolean;
  homeHref: string;
}) {
  const t = useTranslations();
  const { user } = useUser();
  const email = user?.primaryEmailAddress?.emailAddress ?? null;
  const body = [
    sentWithText(withPage, files, t),
    email === null ? null : t("Feedback.sentReply", { email }),
  ]
    .filter((part) => part !== null)
    .join(" ");
  return (
    <div className="flex flex-col items-start gap-3" role="status">
      <h2 className="text-lg font-medium text-primary">{t("Feedback.sentTitle")}</h2>
      {body ? <p className="text-body text-secondary">{body}</p> : null}
      <Button asChild variant="outline" className="mt-3">
        <Link href={homeHref}>{t("Feedback.backTo")}</Link>
      </Button>
    </div>
  );
}

function AttachedFileList({
  files,
  disabled,
  onRemove,
}: {
  files: readonly AttachedFile[];
  disabled: boolean;
  onRemove: (key: string) => void;
}) {
  const t = useTranslations();
  if (files.length === 0) return null;
  return (
    <ul aria-label={t("Feedback.attachedFiles")} className="-mt-2 flex flex-col gap-1">
      {files.map(({ key, file }) => {
        const Icon = file.type === "application/pdf" ? FileTextIcon : ImageIcon;
        return (
          <li key={key} className="flex items-center gap-2 text-body">
            <Icon aria-hidden="true" className="size-4 shrink-0 text-tertiary" />
            <span className="min-w-0 truncate text-primary">{file.name}</span>
            <span className="shrink-0 text-meta tabular-nums text-tertiary">
              {feedbackFileSize(file.size)}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("Feedback.removeAttachment", { name: file.name })}
              disabled={disabled}
              onClick={() => onRemove(key)}
            >
              <XIcon aria-hidden="true" />
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

function AttachControl({
  disabled,
  onPick,
}: {
  disabled: boolean;
  onPick: (files: File[]) => void;
}) {
  const t = useTranslations();
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        iconLeft={<PaperclipIcon aria-hidden="true" />}
        onClick={() => inputRef.current?.click()}
      >
        {t("Feedback.attach")}
      </Button>
      <span className="text-meta text-tertiary">{t("Feedback.attachHint")}</span>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={FEEDBACK_FILE_TYPES.join(",")}
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          const picked = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (picked.length > 0) onPick(picked);
        }}
      />
    </div>
  );
}
