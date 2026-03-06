"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDashboardUrlState } from "@/lib/dashboard-url-state";
import { normalizeApiKeyInput } from "@/lib/playground-api-keys";
import { cn } from "@/lib/utils";
import { Clock3, Copy, Loader2, Play, Sparkles } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type ApiPlaygroundMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ApiPlaygroundFieldOption {
  label: string;
  value: string;
}

export interface ApiPlaygroundFieldConfig {
  key: string;
  label: string;
  placeholder?: string;
  defaultValue?: string;
  kind?: "text" | "select";
  options?: ApiPlaygroundFieldOption[];
  required?: boolean;
  valueType?: "string" | "boolean" | "number" | "string_array";
}

export interface ApiPlaygroundEndpointConfig {
  id: string;
  title: string;
  method: ApiPlaygroundMethod;
  path: string;
  pathFields: ApiPlaygroundFieldConfig[];
  bodyFields: ApiPlaygroundFieldConfig[];
  expectedResponse: unknown;
}

export interface ApiPlaygroundMessage {
  text: string;
  tone?: "critical" | "neutral";
}

interface ExecutionResult {
  ok: boolean;
  status: number;
  statusText: string;
  durationMs: number;
  authMode: "api_key" | "session";
  body: unknown;
}

interface ApiPlaygroundShellProps {
  apiBaseUrl?: string | null;
  apiKeySelector?: ReactNode;
  apiKeyValue: string;
  defaultEndpointId?: string;
  endpoints: ApiPlaygroundEndpointConfig[];
  leftMessages?: ApiPlaygroundMessage[];
  productName: string;
  rightMessages?: ApiPlaygroundMessage[];
}

function getDefaultApiBaseUrl(): string {
  const base = process.env.NEXT_PUBLIC_SDP_API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL;
  return (base ?? "").replace(/\/$/, "");
}

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function buildInitialFieldValues(endpoint: ApiPlaygroundEndpointConfig): Record<string, string> {
  return [...endpoint.pathFields, ...endpoint.bodyFields].reduce<Record<string, string>>(
    (values, field) => {
      values[field.key] = field.defaultValue ?? "";
      return values;
    },
    {}
  );
}

function hasRequestBody(method: ApiPlaygroundMethod): boolean {
  return method !== "GET" && method !== "DELETE";
}

function setNestedValue(target: Record<string, unknown>, path: string, value: unknown) {
  const segments = path.split(".");
  let current: Record<string, unknown> = target;

  segments.forEach((segment, index) => {
    if (index === segments.length - 1) {
      current[segment] = value;
      return;
    }

    const existing = current[segment];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
      current[segment] = {};
    }

    current = current[segment] as Record<string, unknown>;
  });
}

function serializeFieldValue(field: ApiPlaygroundFieldConfig, rawValue: string): unknown {
  if (field.valueType === "boolean") {
    return rawValue === "true";
  }

  if (field.valueType === "number") {
    return Number(rawValue);
  }

  if (field.valueType === "string_array") {
    return rawValue
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  return rawValue;
}

function buildRequestBody(
  fields: ApiPlaygroundFieldConfig[],
  values: Record<string, string>
): Record<string, unknown> | null {
  if (fields.length === 0) {
    return null;
  }

  const payload: Record<string, unknown> = {};

  for (const field of fields) {
    const rawValue = values[field.key] ?? "";
    if (!rawValue.trim()) {
      continue;
    }

    setNestedValue(payload, field.key, serializeFieldValue(field, rawValue));
  }

  return Object.keys(payload).length > 0 ? payload : null;
}

function resolvePath(
  endpoint: ApiPlaygroundEndpointConfig,
  values: Record<string, string>
): string {
  return endpoint.path.replace(/\{([^}]+)\}/g, (_, token) => {
    const value = values[token];
    return value?.trim() ? value.trim() : `{${token}}`;
  });
}

function getMissingRequiredFields(
  endpoint: ApiPlaygroundEndpointConfig,
  values: Record<string, string>
): string[] {
  return [...endpoint.pathFields, ...endpoint.bodyFields]
    .filter((field) => field.required)
    .filter((field) => !(values[field.key] ?? "").trim())
    .map((field) => field.label);
}

function getMethodBadgeClassName(method: ApiPlaygroundMethod): string {
  if (method === "POST") {
    return "bg-[#d8d1c5] text-[#5d5649]";
  }

  if (method === "PUT" || method === "PATCH") {
    return "bg-[#d8dce8] text-[#465168]";
  }

  if (method === "DELETE") {
    return "bg-[#ecd9dc] text-[#7f4452]";
  }

  return "bg-[#dce5d7] text-[#445646]";
}

function isValidSdpApiKey(rawValue: string): boolean {
  return /^sk_(test|live)_[A-Za-z0-9_-]+$/.test(rawValue);
}

function buildFetchSnippet(
  endpoint: ApiPlaygroundEndpointConfig,
  resolvedPath: string,
  requestBody: Record<string, unknown> | null,
  apiBaseUrl: string
): string {
  const lines = [
    'const API_KEY = "<paste_api_key_here>";',
    "",
    `const response = await fetch(\`${apiBaseUrl || "https://api.example.com"}${resolvedPath}\`, {`,
    `  method: "${endpoint.method}",`,
    "  headers: {",
    "    Authorization: `Bearer ${API_KEY}`,",
    '    "Content-Type": "application/json",',
    "  },",
  ];

  if (requestBody && hasRequestBody(endpoint.method)) {
    lines.push(`  body: JSON.stringify(${prettyJson(requestBody)}),`);
  }

  lines.push("});", "", "const data = await response.json();", "console.log(data);");

  return lines.join("\n");
}

function buildAiInstructions(
  endpoint: ApiPlaygroundEndpointConfig,
  fieldValues: Record<string, string>,
  requestBody: Record<string, unknown> | null,
  productName: string
): string {
  const pathParameterLines = endpoint.pathFields.length
    ? endpoint.pathFields
        .map(
          (field) => `- ${field.label}: ${fieldValues[field.key]?.trim() || "fill before sending"}`
        )
        .join("\n")
    : "- none";
  const requestBodySection =
    requestBody && Object.keys(requestBody).length > 0 ? prettyJson(requestBody) : "{}";

  return [
    `Use the ${productName} API endpoint ${endpoint.method} ${endpoint.path}.`,
    "",
    "Path parameters:",
    pathParameterLines,
    "",
    "Request body:",
    requestBodySection,
    "",
    "Return the response body as formatted JSON and call out any validation or auth errors.",
  ].join("\n");
}

function FieldLabel({ children, htmlFor }: { children: string; htmlFor: string }) {
  return (
    <label
      htmlFor={htmlFor}
      className="text-[12px] leading-5 font-medium tracking-[0.02em] text-[rgba(28,28,29,0.68)]"
    >
      {children}
    </label>
  );
}

function EmptyState({ children }: { children: string }) {
  return (
    <div className="rounded-[16px] border border-dashed border-[rgba(28,28,29,0.12)] bg-white/50 px-4 py-5 text-sm text-[rgba(28,28,29,0.54)]">
      {children}
    </div>
  );
}

function MessageCard({ message }: { message: ApiPlaygroundMessage }) {
  return (
    <div
      className={cn(
        "rounded-[14px] border px-4 py-3 text-sm",
        message.tone === "critical"
          ? "border-[#c71f37]/15 bg-[#c71f37]/[0.04] text-[#8a1f2a]"
          : "border-[rgba(28,28,29,0.12)] bg-white/60 text-[rgba(28,28,29,0.68)]"
      )}
    >
      {message.text}
    </div>
  );
}

type HighlightLanguage = "javascript" | "json";

const cssVariablesTheme = {
  name: "css-variables",
  type: "light" as const,
  colors: {
    "editor.background": "var(--shiki-background)",
    "editor.foreground": "var(--shiki-foreground)",
  },
  settings: [
    {
      settings: {
        foreground: "var(--shiki-foreground)",
        background: "var(--shiki-background)",
      },
    },
    {
      scope: ["keyword", "keyword.control", "storage", "storage.type", "storage.modifier"],
      settings: {
        foreground: "var(--shiki-token-keyword)",
        fontStyle: "italic",
      },
    },
    {
      scope: ["keyword.operator", "keyword.operator.assignment"],
      settings: { foreground: "var(--shiki-token-keyword)" },
    },
    {
      scope: ["string", "string.quoted", "string.template"],
      settings: { foreground: "var(--shiki-token-string)" },
    },
    {
      scope: ["comment", "comment.line", "comment.block", "punctuation.definition.comment"],
      settings: {
        foreground: "var(--shiki-token-comment)",
        fontStyle: "italic",
      },
    },
    {
      scope: ["entity.name.function", "support.function", "meta.function-call"],
      settings: { foreground: "var(--shiki-token-function)" },
    },
    {
      scope: ["constant", "constant.numeric", "constant.language", "support.constant"],
      settings: { foreground: "var(--shiki-token-constant)" },
    },
    {
      scope: ["variable.parameter", "meta.parameter", "meta.object-literal.key"],
      settings: { foreground: "var(--shiki-token-parameter)" },
    },
    {
      scope: [
        "punctuation",
        "meta.brace",
        "meta.delimiter",
        "punctuation.separator",
        "punctuation.terminator",
      ],
      settings: { foreground: "var(--shiki-token-punctuation)" },
    },
    {
      scope: [
        "entity.name.type",
        "support.type",
        "support.class",
        "entity.other.inherited-class",
        "meta.type.annotation",
      ],
      settings: { foreground: "var(--shiki-token-type)" },
    },
    {
      scope: ["entity.other.attribute-name", "meta.attribute"],
      settings: { foreground: "var(--shiki-token-attribute)" },
    },
    {
      scope: ["constant.character.escape", "string.regexp"],
      settings: { foreground: "var(--shiki-token-escape)" },
    },
    {
      scope: ["variable.language"],
      settings: {
        foreground: "var(--shiki-token-variable-lang)",
        fontStyle: "italic",
      },
    },
    {
      scope: ["variable", "variable.other", "support.variable"],
      settings: { foreground: "var(--shiki-foreground)" },
    },
  ],
};

const codeBlockDefaultLightVars: CSSProperties = {
  "--code-block-bg": "color-mix(in srgb, var(--gray-50) 60%, white)",
  "--code-block-border": "color-mix(in srgb, var(--gray-1300) 8%, transparent)",
  "--code-block-header-bg": "color-mix(in srgb, var(--gray-1400) 4%, transparent)",
  "--code-block-header-text": "var(--text-medium)",
  "--code-block-header-border": "var(--code-block-border)",
  "--code-block-line-number": "var(--text-low)",
  "--code-block-line-highlight": "color-mix(in srgb, var(--gray-1400) 5%, transparent)",
  "--code-block-scrollbar-thumb": "var(--gray-200)",
  "--shiki-foreground": "var(--gray-1400)",
  "--shiki-background": "transparent",
  "--shiki-token-keyword": "oklch(0.44 0.16 301)",
  "--shiki-token-string": "oklch(0.44 0.12 160)",
  "--shiki-token-comment": "oklch(0.55 0.015 280)",
  "--shiki-token-function": "oklch(0.44 0.14 264)",
  "--shiki-token-constant": "oklch(0.47 0.14 25)",
  "--shiki-token-parameter": "oklch(0.47 0.1 55)",
  "--shiki-token-punctuation": "oklch(0.56 0.01 280)",
  "--shiki-token-type": "oklch(0.44 0.1 195)",
  "--shiki-token-attribute": "oklch(0.44 0.1 145)",
  "--shiki-token-escape": "oklch(0.47 0.12 40)",
  "--shiki-token-variable-lang": "oklch(0.44 0.14 310)",
} as CSSProperties;

let shikiModulePromise: Promise<typeof import("shiki")> | null = null;

function getShikiModule() {
  if (!shikiModulePromise) {
    shikiModulePromise = import("shiki");
  }

  return shikiModulePromise;
}

function CodeBlockContent({
  content,
  language,
}: {
  content: string;
  language: HighlightLanguage;
}) {
  const [renderedHtml, setRenderedHtml] = useState<string>("");

  useEffect(() => {
    let cancelled = false;

    async function highlight() {
      try {
        const shiki = await getShikiModule();
        const html = await shiki.codeToHtml(content, {
          lang: language,
          theme: cssVariablesTheme,
        });

        if (!cancelled) {
          setRenderedHtml(html);
        }
      } catch {
        if (!cancelled) {
          setRenderedHtml("");
        }
      }
    }

    void highlight();

    return () => {
      cancelled = true;
    };
  }, [content, language]);

  return (
    <div
      className="h-full w-full overflow-auto text-sm"
      style={{
        tabSize: 2,
        scrollbarColor: "var(--code-block-scrollbar-thumb) transparent",
      }}
    >
      {renderedHtml ? (
        <div
          // biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki returns HTML for syntax-highlighted code blocks.
          dangerouslySetInnerHTML={{ __html: renderedHtml }}
          className="h-full [&_.shiki]:m-0 [&_.shiki]:h-full [&_.shiki]:min-h-full [&_.shiki]:w-full [&_.shiki]:overflow-visible [&_.shiki]:bg-transparent [&_.shiki]:p-0 [&_.shiki]:text-sm [&_.shiki]:leading-7 [&_.shiki]:[color:var(--shiki-foreground)] [&_.shiki_code]:block [&_.shiki_code]:min-h-full [&_.shiki_code]:min-w-full [&_.shiki_code]:whitespace-normal [&_.shiki_code_.line]:block [&_.shiki_code_.line]:whitespace-pre"
        />
      ) : (
        <pre className="m-0 min-h-full p-0 leading-7 text-[var(--shiki-foreground)]">
          <code>{content}</code>
        </pre>
      )}
    </div>
  );
}

export function ApiPlaygroundShell({
  apiBaseUrl,
  apiKeySelector,
  apiKeyValue,
  defaultEndpointId,
  endpoints,
  leftMessages = [],
  productName,
  rightMessages = [],
}: ApiPlaygroundShellProps) {
  const { replaceSearchParams, searchParams } = useDashboardUrlState();
  const initialEndpoint =
    endpoints.find((endpoint) => endpoint.id === defaultEndpointId) ?? endpoints[0];
  const initialEndpointId = initialEndpoint?.id ?? "";
  const [fieldValues, setFieldValues] = useState<Record<string, string>>(() =>
    initialEndpoint ? buildInitialFieldValues(initialEndpoint) : {}
  );
  const [mobileSection, setMobileSection] = useState<"request" | "output">("request");
  const [activePanel, setActivePanel] = useState<"code" | "response" | "example">("code");
  const [isExecuting, setIsExecuting] = useState(false);
  const [executeError, setExecuteError] = useState<string | null>(null);
  const [executionResult, setExecutionResult] = useState<ExecutionResult | null>(null);
  const [copiedAction, setCopiedAction] = useState<"code" | "ai" | null>(null);
  const endpointsRef = useRef(endpoints);
  const endpointParam = searchParams.get("endpoint");

  const activeEndpointId = endpoints.some((endpoint) => endpoint.id === endpointParam)
    ? (endpointParam ?? "")
    : initialEndpointId;
  const activeEndpoint =
    endpoints.find((endpoint) => endpoint.id === activeEndpointId) ?? initialEndpoint;
  const effectiveApiBaseUrl = useMemo(
    () => (apiBaseUrl ?? getDefaultApiBaseUrl()).replace(/\/$/, ""),
    [apiBaseUrl]
  );

  useEffect(() => {
    endpointsRef.current = endpoints;
  }, [endpoints]);

  const updateEndpointInUrl = useCallback(
    (endpointId: string) => {
      replaceSearchParams({
        endpoint: endpointId,
      });
    },
    [replaceSearchParams]
  );

  useEffect(() => {
    if (!activeEndpointId || endpointParam === activeEndpointId) {
      return;
    }

    updateEndpointInUrl(activeEndpointId);
  }, [activeEndpointId, endpointParam, updateEndpointInUrl]);

  useEffect(() => {
    if (!activeEndpointId) {
      return;
    }

    const endpoint = endpointsRef.current.find((entry) => entry.id === activeEndpointId);
    if (!endpoint) {
      return;
    }

    setFieldValues(buildInitialFieldValues(endpoint));
    setMobileSection("request");
    setActivePanel("code");
    setExecutionResult(null);
    setExecuteError(null);
  }, [activeEndpointId]);

  const requestBody = useMemo(
    () => (activeEndpoint ? buildRequestBody(activeEndpoint.bodyFields, fieldValues) : null),
    [activeEndpoint, fieldValues]
  );
  const resolvedPath = useMemo(
    () => (activeEndpoint ? resolvePath(activeEndpoint, fieldValues) : ""),
    [activeEndpoint, fieldValues]
  );
  const codeSnippet = useMemo(
    () =>
      activeEndpoint
        ? buildFetchSnippet(activeEndpoint, resolvedPath, requestBody, effectiveApiBaseUrl)
        : "",
    [activeEndpoint, effectiveApiBaseUrl, requestBody, resolvedPath]
  );
  const exampleBody = useMemo(
    () => (activeEndpoint ? prettyJson(activeEndpoint.expectedResponse) : "{}"),
    [activeEndpoint]
  );
  const responseBody = useMemo(() => {
    if (executionResult) {
      return prettyJson(executionResult.body);
    }

    if (executeError) {
      return prettyJson({ error: executeError });
    }

    return prettyJson({
      message: "Run request to inspect the live API output for this endpoint.",
    });
  }, [executionResult, executeError]);
  const aiInstructions = useMemo(
    () =>
      activeEndpoint
        ? buildAiInstructions(activeEndpoint, fieldValues, requestBody, productName)
        : "",
    [activeEndpoint, fieldValues, productName, requestBody]
  );

  if (!activeEndpoint) {
    return null;
  }

  const panelContent =
    activePanel === "code" ? codeSnippet : activePanel === "response" ? responseBody : exampleBody;
  const panelLanguage: HighlightLanguage = activePanel === "code" ? "javascript" : "json";

  const getFieldId = (fieldKey: string) =>
    `${activeEndpoint.id}-${fieldKey.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

  const updateFieldValue = (fieldKey: string, value: string) => {
    setFieldValues((current) => ({
      ...current,
      [fieldKey]: value,
    }));
  };

  const copyText = async (text: string, action: "code" | "ai") => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedAction(action);
      window.setTimeout(() => setCopiedAction(null), 1600);
    } catch {
      setCopiedAction(null);
    }
  };

  const handleReset = () => {
    setFieldValues(buildInitialFieldValues(activeEndpoint));
    setMobileSection("request");
    setActivePanel("code");
    setExecutionResult(null);
    setExecuteError(null);
  };

  const handleExecute = async () => {
    setExecuteError(null);
    setExecutionResult(null);

    const missingFields = getMissingRequiredFields(activeEndpoint, fieldValues);
    if (missingFields.length > 0) {
      setExecuteError(`Complete required fields: ${missingFields.join(", ")}`);
      setActivePanel("response");
      return;
    }

    const normalizedApiKey = normalizeApiKeyInput(apiKeyValue);
    const hasApiKey = Boolean(normalizedApiKey);

    if (hasApiKey && !isValidSdpApiKey(normalizedApiKey)) {
      setExecuteError(
        "Invalid API key format. Use a raw key value like sk_test_... or sk_live_... with a valid suffix."
      );
      setActivePanel("response");
      return;
    }

    const startedAt = Date.now();
    setIsExecuting(true);

    try {
      const proxyResponse = await fetch("/api/playground/execute", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          method: activeEndpoint.method,
          path: resolvedPath,
          body: requestBody,
          apiKey: hasApiKey ? normalizedApiKey : null,
        }),
      });

      const envelope = (await proxyResponse.json()) as {
        ok?: boolean;
        status?: number;
        statusText?: string;
        body?: unknown;
        error?: string;
      };

      if (!proxyResponse.ok || envelope.status === undefined || envelope.statusText === undefined) {
        setExecuteError(envelope.error ?? "Playground execution failed.");
        setActivePanel("response");
        return;
      }

      setExecutionResult({
        ok: envelope.ok ?? false,
        status: envelope.status,
        statusText: envelope.statusText,
        durationMs: Date.now() - startedAt,
        authMode: hasApiKey ? "api_key" : "session",
        body: envelope.body ?? {},
      });
      setMobileSection("output");
      setActivePanel("response");
    } catch (error) {
      setExecuteError(error instanceof Error ? error.message : "Request execution failed.");
      setMobileSection("output");
      setActivePanel("response");
    } finally {
      setIsExecuting(false);
    }
  };

  const statusToneClasses = executionResult
    ? executionResult.ok
      ? "bg-[#ece9dd] text-[#4d4a42]"
      : "bg-[#f6d9de] text-[#8a1f2a]"
    : executeError
      ? "bg-[#f6d9de] text-[#8a1f2a]"
      : "bg-[#ece9dd] text-[#6b675e]";
  const statusLabel = executionResult
    ? `${executionResult.status} ${executionResult.statusText}`
    : executeError
      ? "Request failed"
      : "Ready";

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col overflow-hidden">
      <div className="pointer-events-none absolute top-0 bottom-0 left-1/2 hidden w-px -translate-x-1/2 bg-[rgba(28,28,29,0.1)] lg:block" />
      <div className="grid shrink-0 border-b border-[rgba(28,28,29,0.1)] lg:grid-cols-2">
        <div className="px-6 py-5">
          <div className="relative">
            <div className="pointer-events-none flex h-11 w-full items-center rounded-[14px] border border-[rgba(28,28,29,0.12)] bg-white px-3 shadow-none">
              <span className="flex min-w-0 items-center gap-3 pr-8">
                <span
                  className={cn(
                    "inline-flex rounded-[8px] px-3 py-1 text-[12px] font-semibold tracking-[0.06em]",
                    getMethodBadgeClassName(activeEndpoint.method)
                  )}
                >
                  {activeEndpoint.method}
                </span>
                <span className="truncate text-[15px] font-medium text-[#1c1c1d]">
                  {activeEndpoint.title}
                </span>
              </span>
            </div>
            <select
              aria-label="Select API endpoint"
              className="absolute inset-0 h-full w-full cursor-pointer appearance-none rounded-[14px] opacity-0"
              value={activeEndpoint.id}
              onChange={(event) => updateEndpointInUrl(event.currentTarget.value)}
            >
              {endpoints.map((endpoint) => (
                <option key={endpoint.id} value={endpoint.id}>
                  {endpoint.method} {endpoint.title}
                </option>
              ))}
            </select>
            <svg
              aria-hidden="true"
              viewBox="0 0 16 16"
              className="pointer-events-none absolute top-1/2 right-4 h-4 w-4 -translate-y-1/2 text-[rgba(28,28,29,0.42)]"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="m4 6 4 4 4-4" />
            </svg>
          </div>
        </div>

        <div className="border-t border-[rgba(28,28,29,0.1)] px-6 py-5 lg:border-t-0">
          <div className="flex justify-stretch lg:justify-end">{apiKeySelector ?? null}</div>
        </div>
      </div>

      <div className="border-b border-[rgba(28,28,29,0.1)] px-6 py-4 lg:hidden">
        <div className="grid grid-cols-2 gap-1 rounded-full bg-[rgba(28,28,29,0.06)] p-1">
          {(
            [
              ["request", "Request"],
              ["output", "Output"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setMobileSection(value)}
              className={cn(
                "rounded-full px-4 py-2 text-sm font-medium transition-colors",
                mobileSection === value
                  ? "bg-white text-[#1c1c1d] shadow-[0_1px_2px_rgba(28,28,29,0.08)]"
                  : "text-[rgba(28,28,29,0.54)]"
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col border-b border-[rgba(28,28,29,0.1)] lg:grid lg:grid-cols-2">
        <div
          className={cn("min-h-0", mobileSection === "request" ? "flex-1" : "hidden", "lg:block")}
        >
          <div className="flex h-full min-h-0 flex-col px-6 py-6">
            {leftMessages.length > 0 ? (
              <div className="mb-4 shrink-0 space-y-4">
                {leftMessages.map((message) => (
                  <MessageCard
                    key={`${message.tone ?? "neutral"}-${message.text}`}
                    message={message}
                  />
                ))}
              </div>
            ) : null}

            <div className="min-h-0 flex-1 space-y-6 overflow-y-auto lg:pr-2">
              <section className="space-y-3">
                <h2 className="text-[18px] leading-6 font-medium text-[#1c1c1d]">
                  Path Parameters
                </h2>
                {activeEndpoint.pathFields.length === 0 ? (
                  <EmptyState>This endpoint does not require path parameters.</EmptyState>
                ) : (
                  <div className="space-y-4">
                    {activeEndpoint.pathFields.map((field) => (
                      <div key={field.key} className="space-y-2">
                        <FieldLabel htmlFor={getFieldId(field.key)}>{field.label}</FieldLabel>
                        <Input
                          id={getFieldId(field.key)}
                          value={fieldValues[field.key] ?? ""}
                          onChange={(event) =>
                            updateFieldValue(field.key, event.currentTarget.value)
                          }
                          placeholder={field.placeholder}
                          className="h-11 rounded-[12px] border-[rgba(28,28,29,0.12)] bg-white px-4 shadow-none"
                        />
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="space-y-3">
                <h2 className="text-[18px] leading-6 font-medium text-[#1c1c1d]">Request body</h2>
                {activeEndpoint.bodyFields.length === 0 ? (
                  <EmptyState>This endpoint does not require a JSON request body.</EmptyState>
                ) : (
                  <div className="space-y-4">
                    {activeEndpoint.bodyFields.map((field) => (
                      <div key={field.key} className="space-y-2">
                        <FieldLabel htmlFor={getFieldId(field.key)}>{field.label}</FieldLabel>
                        {field.kind === "select" ? (
                          <select
                            id={getFieldId(field.key)}
                            value={fieldValues[field.key] ?? ""}
                            onChange={(event) =>
                              updateFieldValue(field.key, event.currentTarget.value)
                            }
                            className="h-11 w-full rounded-[12px] border border-[rgba(28,28,29,0.12)] bg-white px-4 text-sm text-[#1c1c1d] outline-none transition-[box-shadow,border-color] focus:border-[rgba(28,28,29,0.28)] focus:ring-2 focus:ring-[rgba(28,28,29,0.12)]"
                          >
                            <option value="">{field.placeholder ?? "Select value"}</option>
                            {(field.options ?? []).map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <Input
                            id={getFieldId(field.key)}
                            value={fieldValues[field.key] ?? ""}
                            onChange={(event) =>
                              updateFieldValue(field.key, event.currentTarget.value)
                            }
                            placeholder={field.placeholder}
                            className="h-11 rounded-[12px] border-[rgba(28,28,29,0.12)] bg-white px-4 shadow-none"
                          />
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          </div>
        </div>

        <div
          className={cn(
            "min-h-0 border-t border-[rgba(28,28,29,0.1)] lg:border-t-0",
            mobileSection === "output" ? "flex-1" : "hidden",
            "lg:flex lg:h-full lg:min-h-0 lg:flex-col"
          )}
        >
          <div className="flex h-full min-h-0 flex-col px-6 py-6">
            {rightMessages.length > 0 ? (
              <div className="mb-4 shrink-0 space-y-4">
                {rightMessages.map((message) => (
                  <MessageCard
                    key={`${message.tone ?? "neutral"}-${message.text}`}
                    message={message}
                  />
                ))}
              </div>
            ) : null}

            <div className="mb-4 shrink-0 rounded-full bg-[rgba(28,28,29,0.06)] p-1">
              <div className="grid grid-cols-3 gap-1">
                {(["code", "response", "example"] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    onClick={() => setActivePanel(tab)}
                    className={cn(
                      "rounded-full px-4 py-2 text-sm font-medium capitalize transition-colors",
                      activePanel === tab
                        ? "bg-white text-[#1c1c1d] shadow-[0_1px_2px_rgba(28,28,29,0.08)]"
                        : "text-[rgba(28,28,29,0.54)]"
                    )}
                  >
                    {tab}
                  </button>
                ))}
              </div>
            </div>

            <div
              className="code-block-line-numbers group relative flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-[8px]"
              style={{
                ...codeBlockDefaultLightVars,
                border: "1px solid var(--code-block-border)",
                background: "var(--code-block-bg)",
                fontFamily: "var(--font-berkeley-mono), ui-monospace, monospace",
              }}
            >
              <div className="min-h-0 flex-1 overflow-hidden">
                <CodeBlockContent content={panelContent} language={panelLanguage} />
              </div>
              <div
                className="flex shrink-0 flex-wrap items-center gap-2 px-4 py-3 text-sm"
                style={{
                  background: "var(--code-block-header-bg)",
                  color: "var(--code-block-header-text)",
                  boxShadow: "inset 0 1px 0 var(--code-block-header-border)",
                }}
              >
                <span className="text-[rgba(28,28,29,0.58)]">Status:</span>
                <span
                  className={cn(
                    "rounded-full px-2.5 py-1 text-xs font-semibold",
                    statusToneClasses
                  )}
                >
                  {statusLabel}
                </span>
                {executionResult ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-[#ece9dd] px-2.5 py-1 text-xs font-medium text-[rgba(28,28,29,0.68)]">
                    <Clock3 className="h-3 w-3" />
                    {executionResult.durationMs}ms
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid shrink-0 lg:grid-cols-2">
        <div className="flex flex-wrap items-center gap-3 px-6 py-5">
          <Button
            type="button"
            onClick={handleExecute}
            disabled={isExecuting}
            className="h-10 rounded-[10px] bg-[#101011] px-4 text-white hover:bg-black max-sm:flex-1"
          >
            {isExecuting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4 fill-current" />
            )}
            Run request
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={handleReset}
            className="h-10 rounded-[10px] px-2 text-[rgba(28,28,29,0.72)] hover:bg-transparent hover:text-[#1c1c1d]"
          >
            Reset
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-[rgba(28,28,29,0.1)] px-6 py-5 lg:border-t-0">
          <Button
            type="button"
            variant="outline"
            onClick={() => copyText(codeSnippet, "code")}
            className="h-10 rounded-[10px] border-[rgba(28,28,29,0.12)] bg-white px-4 max-sm:flex-1"
          >
            <Copy className="h-4 w-4" />
            {copiedAction === "code" ? "Copied" : "Copy Code"}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => copyText(aiInstructions, "ai")}
            className="h-10 rounded-[10px] border-[rgba(28,28,29,0.12)] bg-white px-4 max-sm:flex-1"
          >
            <Sparkles className="h-4 w-4" />
            {copiedAction === "ai" ? "Copied" : "AI instructions"}
          </Button>
        </div>
      </div>
    </div>
  );
}
