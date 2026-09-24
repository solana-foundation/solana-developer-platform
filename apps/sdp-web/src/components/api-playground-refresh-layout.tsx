"use client";

import { Tab, TabList, Tabs } from "@solana/design-system/tabs";
import { ChevronDown, ChevronsUpDown, Copy, Loader2, Play, Sparkles, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type {
  ApiPlaygroundEndpointConfig,
  ApiPlaygroundExecution,
  ApiPlaygroundFieldConfig,
  ApiPlaygroundMessage,
} from "@/components/api-playground-shell";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/input";
import { StatusText } from "@/components/ui/status-text";
import { useTranslations } from "@/i18n/provider";
import { HighlightedCode } from "@/lib/shiki-code";

type RequestView = "form" | "raw" | "code";

const REQUEST_VIEWS = [
  { value: "form", labelKey: "Shared.SharedComponents.playgroundForm" },
  { value: "raw", labelKey: "Shared.SharedComponents.playgroundRaw" },
  { value: "code", labelKey: "Shared.SharedComponents.code" },
] as const;

// The same indicator fix the header tabs carry: the design-system indicator reads its geometry
// from these variables.
const TAB_LIST_CLASS =
  "gap-6 [&>span]:![translate:var(--active-tab-left)_0] [&>span]:!w-[var(--active-tab-width)]";

const SELECT_CLASS =
  "h-11 w-full cursor-pointer appearance-none border-0 border-b border-border-default bg-transparent pr-8 text-field text-primary outline-none transition-colors hover:border-border-strong focus:border-border-strong";

function subscribeToNothing() {
  return () => {};
}

/** Whether the viewer's keyboard names the run shortcut ⌘ rather than Ctrl. */
function useApplePlatform(): boolean {
  return useSyncExternalStore(
    subscribeToNothing,
    () => /Mac|iPhone|iPad/.test(navigator.platform),
    () => true
  );
}

function endpointGroups(endpoints: ApiPlaygroundEndpointConfig[]) {
  const groups = new Map<string, ApiPlaygroundEndpointConfig[]>();
  for (const endpoint of endpoints) {
    const key = endpoint.group ?? "";
    groups.set(key, [...(groups.get(key) ?? []), endpoint]);
  }
  return [...groups.entries()];
}

/** Endpoint options, grouped when the endpoints name their families. */
export function ApiPlaygroundEndpointOptions({
  endpoints,
}: {
  endpoints: ApiPlaygroundEndpointConfig[];
}) {
  const option = (endpoint: ApiPlaygroundEndpointConfig) => (
    <option key={endpoint.id} value={endpoint.id} className="bg-surface-raised text-primary">
      {endpoint.method} {endpoint.title}
    </option>
  );
  const groups = endpointGroups(endpoints);
  if (groups.length < 2) {
    return <>{endpoints.map(option)}</>;
  }
  return (
    <>
      {groups.map(([group, members]) =>
        group ? (
          <optgroup key={group} label={group}>
            {members.map(option)}
          </optgroup>
        ) : (
          members.map(option)
        )
      )}
    </>
  );
}

function buildRawRequest(
  endpoint: ApiPlaygroundEndpointConfig,
  resolvedPath: string,
  requestBody: unknown | null,
  apiHost: string | null,
  keyPlaceholder: string
): string {
  const lines = [`${endpoint.method} ${resolvedPath} HTTP/1.1`];
  if (apiHost) {
    lines.push(`Host: ${apiHost}`);
  }
  lines.push(`Authorization: Bearer ${keyPlaceholder}`, "Content-Type: application/json");
  if (requestBody && endpoint.method !== "GET") {
    lines.push("", JSON.stringify(requestBody, null, 2));
  }
  return lines.join("\n");
}

function PlaygroundField({
  field,
  id,
  value,
  onChange,
}: {
  field: ApiPlaygroundFieldConfig;
  id: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useTranslations();
  let control: ReactNode;
  if (field.kind === "select") {
    control = (
      <div className="relative">
        <select
          id={id}
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
          className={SELECT_CLASS}
        >
          <option value="">{field.placeholder ?? t("Shared.SharedComponents.selectValue")}</option>
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 right-1 size-4 -translate-y-1/2 text-secondary"
        />
      </div>
    );
  } else if (field.kind === "textarea") {
    control = (
      <textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={field.placeholder}
        rows={8}
        spellCheck={false}
        className="w-full resize-y rounded-control border border-border-default bg-transparent px-3 py-2.5 font-mono text-meta text-primary outline-none transition-colors hover:border-border-strong focus:border-border-strong"
      />
    );
  } else {
    control = (
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={field.placeholder}
        iconRight={
          value ? (
            <button
              type="button"
              onClick={() => onChange("")}
              aria-label={t("Shared.SharedComponents.clearField", { field: field.label })}
              className="pointer-events-auto flex size-5 items-center justify-center rounded-sm text-tertiary hover:text-primary"
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          ) : undefined
        }
      />
    );
  }

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-meta text-secondary">
        {field.label}
        {field.required ? <span className="text-tertiary"> *</span> : null}
      </label>
      {control}
      {field.description ? <p className="text-meta text-tertiary">{field.description}</p> : null}
    </div>
  );
}

function RunShortcut() {
  const apple = useApplePlatform();
  const keys = apple ? ["⌘", "↵"] : ["Ctrl", "↵"];
  return (
    <span aria-hidden="true" className="ml-1 flex items-center gap-1">
      {keys.map((key) => (
        <kbd
          key={key}
          className="flex h-6 min-w-6 items-center justify-center rounded-[6px] border border-on-primary/30 px-1 font-sans text-meta text-on-primary/80"
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}

function CodeBody({ content, language }: { content: string; language: "javascript" | "json" }) {
  return (
    <div
      data-testid="api-playground-code"
      className="min-h-0 overflow-x-auto font-mono text-meta [&_.shiki]:!text-meta"
    >
      <HighlightedCode content={content} language={language} />
    </div>
  );
}

function PlainCode({ content }: { content: string }) {
  return (
    <pre className="overflow-x-auto font-mono text-meta leading-7 whitespace-pre text-primary">
      {content}
    </pre>
  );
}

/** ⌘↵ or Ctrl+↵ runs the request from anywhere on the page while running is allowed. */
function useRunShortcut(onRun: () => void, disabled: boolean) {
  const latest = useRef({ onRun, disabled });
  latest.current = { onRun, disabled };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) {
        return;
      }
      event.preventDefault();
      if (!latest.current.disabled) {
        latest.current.onRun();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

/** The Form view: every field, split into parameters and body when an endpoint has both. */
function RequestForm({
  endpoint,
  fieldValues,
  onFieldChange,
  getFieldId,
}: {
  endpoint: ApiPlaygroundEndpointConfig;
  fieldValues: Record<string, string>;
  onFieldChange: (fieldKey: string, value: string) => void;
  getFieldId: (fieldKey: string) => string;
}) {
  const t = useTranslations();
  const renderFields = (list: ApiPlaygroundFieldConfig[]) =>
    list.map((field) => (
      <PlaygroundField
        key={field.key}
        field={field}
        id={getFieldId(field.key)}
        value={fieldValues[field.key] ?? ""}
        onChange={(value) => onFieldChange(field.key, value)}
      />
    ));
  const { pathFields, bodyFields } = endpoint;

  if (pathFields.length === 0 && bodyFields.length === 0) {
    return <p className="text-body text-tertiary">{t("Shared.SharedComponents.noParameters")}</p>;
  }
  if (pathFields.length === 0 || bodyFields.length === 0) {
    return <div className="space-y-6">{renderFields([...pathFields, ...bodyFields])}</div>;
  }
  return (
    <div className="space-y-8">
      <div className="space-y-6">
        <h3 className="text-meta font-medium text-tertiary">
          {t("Shared.SharedComponents.playgroundParameters")}
        </h3>
        {renderFields(pathFields)}
      </div>
      <div className="space-y-6">
        <h3 className="text-meta font-medium text-tertiary">
          {t("Shared.SharedComponents.playgroundBody")}
        </h3>
        {renderFields(bodyFields)}
      </div>
    </div>
  );
}

/** The Code view: the fetch snippet, with copy actions for it and for AI instructions. */
function CodeView({
  codeSnippet,
  aiInstructions,
  onCopy,
  copiedAction,
}: {
  codeSnippet: string;
  aiInstructions: string;
  onCopy: (text: string, action: "code" | "ai") => void;
  copiedAction: "code" | "ai" | null;
}) {
  const t = useTranslations();
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onCopy(codeSnippet, "code")}
          iconLeft={<Copy className="size-4" aria-hidden="true" />}
        >
          {copiedAction === "code"
            ? t("Shared.SharedComponents.copied")
            : t("Shared.SharedComponents.copyCode")}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onCopy(aiInstructions, "ai")}
          iconLeft={<Sparkles className="size-4" aria-hidden="true" />}
        >
          {copiedAction === "ai"
            ? t("Shared.SharedComponents.copied")
            : t("Shared.SharedComponents.aiInstructions")}
        </Button>
      </div>
      <CodeBody content={codeSnippet} language="javascript" />
    </div>
  );
}

/** "Not run yet", "Running…", or the response's status line and duration in its tone. */
function ExecutionStatus({ execution }: { execution: ApiPlaygroundExecution }) {
  const t = useTranslations();
  if (execution.state === "idle" || execution.state === "running") {
    return (
      <span className="text-tertiary">
        {execution.state === "idle"
          ? t("Shared.SharedComponents.notRunYet")
          : t("Shared.SharedComponents.running")}
      </span>
    );
  }
  const duration =
    execution.durationMs === undefined
      ? null
      : t("Shared.SharedComponents.durationMilliseconds", { duration: execution.durationMs });
  return (
    <StatusText tone={execution.ok ? "positive" : "critical"}>
      {duration ? `${execution.label} · ${duration}` : execution.label}
    </StatusText>
  );
}

export interface ApiPlaygroundRefreshLayoutProps {
  endpoints: ApiPlaygroundEndpointConfig[];
  activeEndpoint: ApiPlaygroundEndpointConfig;
  onEndpointChange: (endpointId: string) => void;
  apiKeySelector?: ReactNode;
  apiHost: string | null;
  requiresApiKey: boolean;
  messages: ApiPlaygroundMessage[];
  fieldValues: Record<string, string>;
  onFieldChange: (fieldKey: string, value: string) => void;
  getFieldId: (fieldKey: string) => string;
  resolvedPath: string;
  requestBody: unknown | null;
  codeSnippet: string;
  aiInstructions: string;
  exampleBody: string;
  execution: ApiPlaygroundExecution;
  responseBody: string;
  onRun: () => void;
  onReset: () => void;
  onCopy: (text: string, action: "code" | "ai") => void;
  copiedAction: "code" | "ai" | null;
}

/**
 * The playground as a refresh surface lays it out: the endpoint and Run on one line, the key
 * and host under it, then the request (form, raw HTTP or code) beside the response. ⌘↵ or
 * Ctrl+↵ runs the request from anywhere on the page.
 */
export function ApiPlaygroundRefreshLayout({
  endpoints,
  activeEndpoint,
  onEndpointChange,
  apiKeySelector,
  apiHost,
  requiresApiKey,
  messages,
  fieldValues,
  onFieldChange,
  getFieldId,
  resolvedPath,
  requestBody,
  codeSnippet,
  aiInstructions,
  exampleBody,
  execution,
  responseBody,
  onRun,
  onReset,
  onCopy,
  copiedAction,
}: ApiPlaygroundRefreshLayoutProps) {
  const t = useTranslations();
  const [view, setView] = useState<RequestView>("form");
  const runDisabled = execution.state === "running" || requiresApiKey;
  useRunShortcut(onRun, runDisabled);
  const hasRun = execution.state === "done" || execution.state === "error";

  return (
    <div className="w-full pb-12">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
        <div className="relative flex min-w-0 items-center gap-5 rounded-control border border-border-default px-5 py-3 transition-colors hover:border-border-strong has-[select:focus-visible]:border-border-strong has-[select:focus-visible]:ring-2 has-[select:focus-visible]:ring-border-default">
          <span className="w-12 shrink-0 font-mono text-meta text-tertiary">
            {activeEndpoint.method}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-subheading text-primary">
              {activeEndpoint.title}
            </span>
            <span className="block truncate font-mono text-meta text-secondary">
              {activeEndpoint.path.split("?", 1)[0]}
            </span>
          </span>
          <ChevronsUpDown aria-hidden="true" className="size-4 shrink-0 text-secondary" />
          <select
            aria-label={t("Shared.SharedComponents.selectApiEndpoint")}
            className="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0"
            value={activeEndpoint.id}
            onChange={(event) => onEndpointChange(event.currentTarget.value)}
          >
            <ApiPlaygroundEndpointOptions endpoints={endpoints} />
          </select>
        </div>
        <Button
          type="button"
          onClick={onRun}
          disabled={runDisabled}
          aria-keyshortcuts="Meta+Enter Control+Enter"
          className="!h-auto min-h-control-lg self-stretch rounded-control px-6"
          iconLeft={
            execution.state === "running" ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : (
              <Play className="size-4" aria-hidden="true" />
            )
          }
        >
          <span className="flex items-center gap-3 whitespace-nowrap">
            {t("Shared.SharedComponents.runRequest")}
            <RunShortcut />
          </span>
        </Button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-meta text-secondary">
        {apiKeySelector ? (
          <>
            <span className="text-tertiary">{t("Shared.SharedComponents.apiKeyLabel")}</span>
            {apiKeySelector}
          </>
        ) : null}
        {apiHost ? (
          <>
            {apiKeySelector ? <span aria-hidden="true">·</span> : null}
            <span className="font-mono text-primary">{apiHost}</span>
          </>
        ) : null}
      </div>
      {requiresApiKey ? (
        <p className="mt-2 text-meta text-tertiary">
          {t("Shared.SharedComponents.apiKeyRequired")}
        </p>
      ) : null}

      {messages.length > 0 ? (
        <div className="mt-6 space-y-3">
          {messages.map((message) => (
            <Callout
              key={`${message.tone ?? "neutral"}-${message.text}`}
              variant={message.tone === "critical" ? "danger" : "info"}
            >
              {message.text}
            </Callout>
          ))}
        </div>
      ) : null}

      <div className="mt-8 grid border-t border-border-default lg:grid-cols-2">
        <section
          aria-labelledby="api-playground-request"
          className="min-w-0 pt-8 lg:border-r lg:border-border-default lg:pr-12"
        >
          <div className="flex items-baseline justify-between gap-4">
            <h2 id="api-playground-request" className="text-subheading text-primary">
              {t("Shared.SharedComponents.request")}
            </h2>
            <button
              type="button"
              onClick={() => {
                setView("form");
                onReset();
              }}
              className="text-body text-secondary hover:text-primary"
            >
              {t("Shared.SharedComponents.reset")}
            </button>
          </div>
          <Tabs
            bordered={false}
            value={view}
            onValueChange={(value) => setView(value as RequestView)}
            className="mt-6"
          >
            <TabList className={TAB_LIST_CLASS}>
              {REQUEST_VIEWS.map((entry) => (
                <Tab key={entry.value} value={entry.value}>
                  {t(entry.labelKey)}
                </Tab>
              ))}
            </TabList>
          </Tabs>

          <div className="mt-8">
            {view === "form" ? (
              <RequestForm
                endpoint={activeEndpoint}
                fieldValues={fieldValues}
                onFieldChange={onFieldChange}
                getFieldId={getFieldId}
              />
            ) : null}
            {view === "raw" ? (
              <PlainCode
                content={buildRawRequest(
                  activeEndpoint,
                  resolvedPath,
                  requestBody,
                  apiHost,
                  t("Shared.SharedComponents.playgroundKeyPlaceholder")
                )}
              />
            ) : null}
            {view === "code" ? (
              <CodeView
                codeSnippet={codeSnippet}
                aiInstructions={aiInstructions}
                onCopy={onCopy}
                copiedAction={copiedAction}
              />
            ) : null}
          </div>
        </section>

        <section
          aria-labelledby="api-playground-response"
          className="min-w-0 border-t border-border-default pt-8 lg:border-t-0 lg:pl-12"
        >
          <div className="flex items-baseline justify-between gap-4">
            <h2 id="api-playground-response" className="text-subheading text-primary">
              {hasRun
                ? t("Shared.SharedComponents.response")
                : t("Shared.SharedComponents.exampleResponse")}
            </h2>
            <p aria-live="polite" className="text-body">
              <ExecutionStatus execution={execution} />
            </p>
          </div>
          <div className="mt-6">
            <CodeBody content={hasRun ? responseBody : exampleBody} language="json" />
          </div>
        </section>
      </div>
    </div>
  );
}
