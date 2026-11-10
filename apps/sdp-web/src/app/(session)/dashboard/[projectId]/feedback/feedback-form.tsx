"use client";

import { useUser } from "@clerk/nextjs";
import { Button } from "@sdp/ui/button";
import { SegmentedControl } from "@sdp/ui/segmented-control";
import { Textarea } from "@sdp/ui/textarea";
import * as Sentry from "@sentry/nextjs";
import { FileTextIcon, ImageIcon, PaperclipIcon, SendIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { type ChangeEvent, useId, useRef, useState, useTransition } from "react";
import { useTranslations } from "@/i18n/provider";
import { dashboardFetch } from "@/lib/dashboard-fetch";
import { useProjectHref } from "@/lib/use-dashboard-project";
import {
  type AttachedFile,
  addFeedbackFiles,
  FEEDBACK_CATEGORIES,
  FEEDBACK_FILE_TYPES,
  FEEDBACK_FILES_MAX,
  type FeedbackCategory,
  type FileRefusal,
  feedbackFileSize,
} from "./feedback-files";

const CATEGORY_LABEL_KEYS = {
  problem: "Feedback.categoryProblem",
  idea: "Feedback.categoryIdea",
  question: "Feedback.categoryQuestion",
} as const;

const HOME_HREF = "/dashboard";

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
export function FeedbackForm({ organizationId }: { organizationId: string }) {
  const t = useTranslations();
  const projectHref = useProjectHref();
  const messageId = useId();
  const [category, setCategory] = useState<FeedbackCategory | "">("");
  const [message, setMessage] = useState("");
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sentFiles, setSentFiles] = useState<number | null>(null);
  const [sending, startSend] = useTransition();
  const homeHref = projectHref(HOME_HREF);
  const takesFiles = Sentry.getClient() !== undefined;

  const pickFiles = (picked: File[]) => {
    const added = addFeedbackFiles(files, picked);
    setFiles(added.files);
    setFileError(added.refusal ? refusalMessage(added.refusal, t) : null);
  };

  const submit = () => {
    const trimmed = message.trim();
    if (!trimmed || sending) return;
    setSendError(null);
    startSend(async () => {
      const result = await sendFeedback({
        organizationId,
        category,
        message: trimmed,
        files,
        toSentry: takesFiles,
      });
      if (result.ok) {
        setSentFiles(files.length);
        return;
      }
      setSendError(
        result.status === 503 || result.status === null
          ? t("Feedback.unavailable")
          : t("Feedback.submitFailed", { error: result.error })
      );
    });
  };

  if (sentFiles !== null) return <FeedbackSent files={sentFiles} homeHref={homeHref} />;

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
          value={category}
          onChange={(value) => setCategory(value as FeedbackCategory)}
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
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder={t("Feedback.messagePlaceholder")}
          disabled={sending}
          className="resize-y text-body"
        />
      </div>

      <AttachedFileList
        files={files}
        disabled={sending}
        onRemove={(key) => {
          setFiles(files.filter((entry) => entry.key !== key));
          setFileError(null);
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
            <Button asChild variant="ghost">
              <Link href={homeHref}>{t("Feedback.cancel")}</Link>
            </Button>
            <Button
              type="submit"
              loading={sending}
              disabled={!message.trim()}
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

/**
 * Files and the replay go to Sentry first, when the deployment runs it, so the email can name
 * the event that holds them; the words then go to the SDP team's inbox through the API.
 */
async function sendFeedback(input: {
  organizationId: string;
  category: FeedbackCategory | "";
  message: string;
  files: readonly AttachedFile[];
  toSentry: boolean;
}) {
  const url = window.location.href;
  let sentryEventId: string | undefined;
  if (input.toSentry) {
    const attachments = await Promise.all(
      input.files.map(async ({ file }) => ({
        filename: file.name,
        data: new Uint8Array(await file.arrayBuffer()),
        contentType: file.type,
      }))
    );
    sentryEventId = Sentry.captureFeedback(
      {
        message: input.message,
        source: "dashboard",
        url,
        tags: input.category ? { feedback_category: input.category } : undefined,
      },
      { includeReplay: true, attachments }
    );
  }
  return dashboardFetch<unknown>(
    `/api/dashboard/organizations/${encodeURIComponent(input.organizationId)}/feedback`,
    {
      method: "POST",
      body: {
        category: input.category || undefined,
        message: input.message,
        pageUrl: url,
        attachmentCount: input.files.length,
        sentryEventId,
      },
    }
  );
}

function FeedbackSent({ files, homeHref }: { files: number; homeHref: string }) {
  const t = useTranslations();
  const { user } = useUser();
  const email = user?.primaryEmailAddress?.emailAddress ?? null;
  let body: string;
  if (email === null) body = t("Feedback.sentBodyNoEmail");
  else if (files === 0) body = t("Feedback.sentBody", { email });
  else if (files === 1) body = t("Feedback.sentBodyOneFile", { email });
  else body = t("Feedback.sentBodyFiles", { email, count: String(files) });
  return (
    <div className="flex flex-col items-start gap-3" role="status">
      <h2 className="text-lg font-medium text-primary">{t("Feedback.sentTitle")}</h2>
      <p className="text-body text-secondary">{body}</p>
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
