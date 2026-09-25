"use client";

import { Tab, TabList, Tabs } from "@solana/design-system/tabs";
import { ChevronDown, ChevronsUpDown, Copy, Loader2, Play, Plus, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type {
  ApiPlaygroundEndpointConfig,
  ApiPlaygroundExecution,
  ApiPlaygroundFieldConfig,
  ApiPlaygroundMessage,
} from "@/components/api-playground-shell";
import { SNIPPET_LANGUAGES, type SnippetLanguage } from "@/components/api-playground-snippets";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { InfoHint } from "@/components/ui/info-hint";
import { StatusText } from "@/components/ui/status-text";
import { useTranslations } from "@/i18n/provider";

type RequestView = "form" | "raw" | "code";
type ResponseView = "body" | "headers";

const REQUEST_VIEWS = [
  { value: "form", labelKey: "Shared.SharedComponents.playgroundForm" },
  { value: "raw", labelKey: "Shared.SharedComponents.playgroundRaw" },
  { value: "code", labelKey: "Shared.SharedComponents.code" },
] as const;

const RESPONSE_VIEWS = [
  { value: "body", labelKey: "Shared.SharedComponents.playgroundBody" },
  { value: "headers", labelKey: "Shared.SharedComponents.playgroundHeaders" },
] as const;

// Language names are the languages' own, the same in every locale.
const SNIPPET_LANGUAGE_NAMES: Record<SnippetLanguage, string> = {
  curl: "cURL",
  ts: "TypeScript",
  py: "Python",
};

// The same indicator fix the header tabs carry: the design-system indicator reads its geometry
// from these variables.
const TAB_LIST_CLASS =
  "gap-6.5 [&>span]:![translate:var(--active-tab-left)_0] [&>span]:!w-[var(--active-tab-width)]";

// The design's playground fields: 36px underline controls with 14px values, tracked -0.01em
// like the deck's other controls.
const FIELD_CLASS =
  "h-9 w-full border-0 border-b border-border-default bg-transparent pr-8 pl-0.5 text-body tracking-[-0.01em] text-primary outline-none transition-colors placeholder:text-tertiary hover:border-border-strong focus:border-border-strong";

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
          className={`${FIELD_CLASS} cursor-pointer appearance-none`}
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
          className="pointer-events-none absolute top-1/2 right-0.5 size-4 -translate-y-1/2 text-secondary"
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
      <div className="relative">
        <input
          id={id}
          value={value}
          onChange={(event) => onChange(event.currentTarget.value)}
          placeholder={field.placeholder}
          className={FIELD_CLASS}
        />
        {value ? (
          <button
            type="button"
            onClick={() => onChange("")}
            aria-label={t("Shared.SharedComponents.clearField", { field: field.label })}
            className="absolute top-1/2 right-0 flex size-6 -translate-y-1/2 items-center justify-center rounded-sm text-tertiary hover:text-primary"
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-meta text-secondary">
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
    <span aria-hidden="true" className="ml-2.5 flex items-center gap-1">
      {keys.map((key) => (
        <kbd
          key={key}
          className="flex h-5 min-w-5 items-center justify-center rounded-[5px] border border-on-primary/30 px-1 font-sans text-meta text-on-primary/80"
        >
          {key}
        </kbd>
      ))}
    </span>
  );
}

/**
 * Code as the design sets it: 13px on 20px lines, one ink, wrapped rather than scrolled
 * sideways. A wrapped line hangs 2ch in from its own indent, so nesting still reads.
 */
function PlainCode({
  content,
  className = "text-primary",
}: {
  content: string;
  className?: string;
}) {
  return (
    <pre
      className={`font-mono text-meta leading-5 whitespace-pre-wrap [overflow-wrap:anywhere] ${className}`}
    >
      {content.split("\n").map((line, index) => {
        const indent = line.length - line.trimStart().length;
        return (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: a line's place is its identity.
            key={index}
            className="block"
            style={{ paddingLeft: `${indent + 2}ch`, textIndent: "-2ch" }}
          >
            {line.trimStart() || "\u00a0"}
          </span>
        );
      })}
    </pre>
  );
}

/** ⌘↵ or Ctrl+↵ runs the request from anywhere on the page while running is allowed. */
function useRunShortcut(onRun: () => void, disabled: boolean) {
  const latest = useRef({ onRun, disabled });
  // Written after commit, not during render: React may replay or discard a render.
  useEffect(() => {
    latest.current = { onRun, disabled };
  });
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

/**
 * The Code view's controls, at the end of the tab row as the design has them: the snippet's
 * language and a copy of it.
 */
function SnippetControls({
  language,
  onLanguageChange,
  snippet,
  onCopy,
  copied,
}: {
  language: SnippetLanguage;
  onLanguageChange: (language: SnippetLanguage) => void;
  snippet: string;
  onCopy: (text: string, action: "code" | "ai") => void;
  copied: boolean;
}) {
  const t = useTranslations();
  return (
    <span className="flex items-center gap-1">
      <span className="relative inline-flex h-6 items-center gap-1 rounded-control px-2 text-body text-primary transition-colors hover:bg-fill-subtle has-[select:focus-visible]:outline-2 has-[select:focus-visible]:outline-primary">
        {SNIPPET_LANGUAGE_NAMES[language]}
        <ChevronDown aria-hidden="true" className="size-3.5 text-tertiary" />
        <select
          aria-label={t("Shared.SharedComponents.snippetLanguage")}
          className="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0"
          value={language}
          onChange={(event) => {
            const next = SNIPPET_LANGUAGES.find((entry) => entry === event.currentTarget.value);
            if (next) onLanguageChange(next);
          }}
        >
          {SNIPPET_LANGUAGES.map((entry) => (
            <option key={entry} value={entry}>
              {SNIPPET_LANGUAGE_NAMES[entry]}
            </option>
          ))}
        </select>
      </span>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={() => onCopy(snippet, "code")}
        iconLeft={copied ? undefined : <Copy className="size-3.5" aria-hidden="true" />}
      >
        {copied ? t("Shared.SharedComponents.copied") : t("Shared.SharedComponents.copy")}
      </Button>
    </span>
  );
}

/** The Code view: the call in the chosen language, then a prompt an assistant can write it from. */
function CodeView({
  snippet,
  aiInstructions,
  onCopy,
  copiedAction,
}: {
  snippet: string;
  aiInstructions: string;
  onCopy: (text: string, action: "code" | "ai") => void;
  copiedAction: "code" | "ai" | null;
}) {
  const t = useTranslations();
  return (
    <div>
      <div data-testid="api-playground-code">
        <PlainCode content={snippet} />
      </div>
      <div className="mt-6 flex items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="-ml-2"
          onClick={() => onCopy(aiInstructions, "ai")}
          iconLeft={
            copiedAction === "ai" ? undefined : <Sparkles className="size-3.5" aria-hidden="true" />
          }
        >
          {copiedAction === "ai"
            ? t("Shared.SharedComponents.copied")
            : t("Shared.SharedComponents.copyAssistantPrompt")}
        </Button>
        <InfoHint text={t("Shared.SharedComponents.assistantPromptHint")} />
      </div>
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

/** The response's headers as `name: value` lines, or why there are none to show. */
function ResponseHeaders({
  headers,
  hasRun,
}: {
  headers: Record<string, string> | null;
  hasRun: boolean;
}) {
  const t = useTranslations();
  const entries = hasRun && headers ? Object.entries(headers) : [];
  if (entries.length === 0) {
    return (
      <p className="text-body text-tertiary">
        {hasRun
          ? t("Shared.SharedComponents.noResponseHeaders")
          : t("Shared.SharedComponents.headersAfterRun")}
      </p>
    );
  }
  return <PlainCode content={entries.map(([name, value]) => `${name}: ${value}`).join("\n")} />;
}

/**
 * The endpoint picker and Run, on one 60px line. With no key in the project, Run becomes
 * "Create an API key" for someone who may make one, as the design does: there is nothing to run
 * a request with until then.
 */
function EndpointLine({
  endpoints,
  activeEndpoint,
  onEndpointChange,
  execution,
  runDisabled,
  onRun,
  createApiKeyHref,
}: Pick<
  ApiPlaygroundRefreshLayoutProps,
  "endpoints" | "activeEndpoint" | "onEndpointChange" | "execution" | "onRun" | "createApiKeyHref"
> & { runDisabled: boolean }) {
  const t = useTranslations();
  return (
    <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]">
      {/* 60px tall: two lines of 18/24 and 13/16 inside 9px and the rule. */}
      <div className="relative flex min-w-0 items-center gap-3 rounded-control border border-border-default px-3 py-[9px] transition-colors hover:border-border-strong has-[select:focus-visible]:border-border-strong has-[select:focus-visible]:ring-2 has-[select:focus-visible]:ring-border-default">
        <span className="min-w-9 shrink-0 font-mono text-meta text-tertiary">
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
      {/* The design's Run sits a pixel inside the picker's rule, top and bottom. */}
      {createApiKeyHref ? (
        <Button asChild className="!h-[58px] self-center rounded-control !px-5">
          <Link href={createApiKeyHref} data-playground-create-key="">
            <Plus className="size-4" aria-hidden="true" />
            {t("Shared.SharedComponents.createAnApiKey")}
          </Link>
        </Button>
      ) : (
        <Button
          type="button"
          onClick={onRun}
          disabled={runDisabled}
          aria-keyshortcuts="Meta+Enter Control+Enter"
          className="!h-[58px] !gap-0 self-center rounded-control !px-5"
        >
          <span className="flex items-center whitespace-nowrap">
            <span className="flex items-center gap-1.5">
              {execution.state === "running" ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Play className="size-4" aria-hidden="true" />
              )}
              {t("Shared.SharedComponents.runRequest")}
            </span>
            <RunShortcut />
          </span>
        </Button>
      )}
    </div>
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
  /** The call in each language the Code view offers. */
  snippets: Record<SnippetLanguage, string>;
  aiInstructions: string;
  exampleBody: string;
  execution: ApiPlaygroundExecution;
  responseBody: string;
  /** The last run's response headers; null until a request has come back. */
  responseHeaders: Record<string, string> | null;
  onRun: () => void;
  onReset: () => void;
  onCopy: (text: string, action: "code" | "ai") => void;
  copiedAction: "code" | "ai" | null;
  /** Where to make a key when the project has none; set only for someone who may make one. */
  createApiKeyHref?: string;
}

/**
 * The playground as a refresh surface lays it out: the endpoint and Run on one line, the key
 * and host under it, then the request (form, raw HTTP or code) beside the response (body or
 * headers). ⌘↵ or Ctrl+↵ runs the request from anywhere on the page.
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
  snippets,
  aiInstructions,
  exampleBody,
  execution,
  responseBody,
  responseHeaders,
  onRun,
  onReset,
  onCopy,
  copiedAction,
  createApiKeyHref,
}: ApiPlaygroundRefreshLayoutProps) {
  const t = useTranslations();
  const [view, setView] = useState<RequestView>("form");
  const [responseView, setResponseView] = useState<ResponseView>("body");
  const [language, setLanguage] = useState<SnippetLanguage>("curl");
  const runDisabled = execution.state === "running" || requiresApiKey;
  const createKeyHref = requiresApiKey ? createApiKeyHref : undefined;
  useRunShortcut(onRun, runDisabled);
  const hasRun = execution.state === "done" || execution.state === "error";

  return (
    <div className="w-full pb-12">
      <EndpointLine
        endpoints={endpoints}
        activeEndpoint={activeEndpoint}
        onEndpointChange={onEndpointChange}
        execution={execution}
        runDisabled={runDisabled}
        onRun={onRun}
        createApiKeyHref={createKeyHref}
      />

      <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-2 text-meta text-secondary">
        {apiKeySelector ? (
          <>
            <span>{t("Shared.SharedComponents.apiKeyLabel")}</span>
            {apiKeySelector}
          </>
        ) : null}
        {apiHost ? (
          <>
            {apiKeySelector ? (
              <span aria-hidden="true" className="text-tertiary">
                ·
              </span>
            ) : null}
            <span className="font-mono">{apiHost}</span>
          </>
        ) : null}
      </div>
      {/* Someone who cannot make a key is told why Run waits; the others get the button. */}
      {requiresApiKey && !createKeyHref ? (
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

      {/* The design's rhythm: 28px to the rule, 40px under it to the two 36px section rows (the
          divider between the halves starts there, not at the rule), 24px to the view tabs. */}
      <div className="mt-7 grid border-t border-border-default pt-10 lg:grid-cols-2">
        <section
          aria-labelledby="api-playground-request"
          className="min-w-0 pb-10 lg:border-r lg:border-border-default lg:pr-10 lg:pb-0"
        >
          <div className="flex h-9 items-center justify-between gap-4">
            <h2 id="api-playground-request" className="text-body font-medium text-primary">
              {t("Shared.SharedComponents.request")}
            </h2>
            <button
              type="button"
              onClick={() => {
                setView("form");
                onReset();
              }}
              className="h-9 rounded-control px-2 text-body text-secondary transition-colors hover:bg-fill-subtle hover:text-primary"
            >
              {t("Shared.SharedComponents.reset")}
            </button>
          </div>
          <div className="mt-6 flex items-center justify-between gap-3">
            <Tabs
              bordered={false}
              value={view}
              onValueChange={(value) => setView(value as RequestView)}
              className="shrink-0"
            >
              <TabList className={TAB_LIST_CLASS}>
                {REQUEST_VIEWS.map((entry) => (
                  <Tab key={entry.value} value={entry.value}>
                    {t(entry.labelKey)}
                  </Tab>
                ))}
              </TabList>
            </Tabs>
            {view === "code" ? (
              <SnippetControls
                language={language}
                onLanguageChange={setLanguage}
                snippet={snippets[language]}
                onCopy={onCopy}
                copied={copiedAction === "code"}
              />
            ) : null}
          </div>

          <div className="mt-10">
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
                snippet={snippets[language]}
                aiInstructions={aiInstructions}
                onCopy={onCopy}
                copiedAction={copiedAction}
              />
            ) : null}
          </div>
        </section>

        <section
          aria-labelledby="api-playground-response"
          className="min-w-0 border-t border-border-default pt-10 lg:border-t-0 lg:pt-0 lg:pl-10"
        >
          <div className="flex h-9 items-center justify-between gap-4">
            <h2 id="api-playground-response" className="text-body font-medium text-primary">
              {hasRun
                ? t("Shared.SharedComponents.response")
                : t("Shared.SharedComponents.exampleResponse")}
            </h2>
            <p aria-live="polite" className="pr-1 text-meta">
              <ExecutionStatus execution={execution} />
            </p>
          </div>
          <Tabs
            bordered={false}
            value={responseView}
            onValueChange={(value) => setResponseView(value as ResponseView)}
            className="mt-6"
          >
            <TabList className={TAB_LIST_CLASS}>
              {RESPONSE_VIEWS.map((entry) => (
                <Tab key={entry.value} value={entry.value}>
                  {t(entry.labelKey)}
                </Tab>
              ))}
            </TabList>
          </Tabs>
          <div className="mt-4">
            {responseView === "body" ? (
              hasRun ? (
                <div data-testid="api-playground-code">
                  <PlainCode content={responseBody} />
                </div>
              ) : (
                // The example reads as a placeholder: one quiet tone, no highlighting.
                <div data-testid="api-playground-code">
                  <PlainCode content={exampleBody} className="text-tertiary" />
                </div>
              )
            ) : (
              <ResponseHeaders headers={responseHeaders} hasRun={hasRun} />
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
