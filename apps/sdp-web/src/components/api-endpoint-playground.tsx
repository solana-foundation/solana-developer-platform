"use client";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getStoredApiKeySecret, normalizeApiKeyInput, storeApiKeySecret } from "@/lib/playground-api-keys";
import { Check, ChevronDown, Copy, Loader2, Play } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

const CUSTOM_KEY_OPTION_ID = "__custom__";

export type ApiEndpointMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ApiPlaygroundApiKeyOption {
  id: string;
  name: string;
  keyPrefix: string;
  role: string;
  environment: string;
}

interface ExecutionResult {
  ok: boolean;
  status: number;
  statusText: string;
  durationMs: number;
  body: unknown;
}

export interface ApiEndpointPlaygroundProps {
  title: string;
  description: string;
  method: ApiEndpointMethod;
  path: string;
  expectedResponse: unknown;
  requestBodyExample?: unknown;
  apiKeys: ApiPlaygroundApiKeyOption[];
  apiBaseUrl?: string | null;
  defaultOpen?: boolean;
}

function getDefaultApiBaseUrl(): string {
  const base = process.env.NEXT_PUBLIC_SDP_API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL;
  return (base ?? "").replace(/\/$/, "");
}

function tryParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function formatPath(path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }

  if (!path.startsWith("/")) {
    return `/${path}`;
  }

  return path;
}

function resolveEndpointUrl(path: string, baseUrl: string): string {
  const normalizedPath = formatPath(path);

  if (normalizedPath.startsWith("http://") || normalizedPath.startsWith("https://")) {
    return normalizedPath;
  }

  if (!baseUrl) {
    throw new Error("Missing API base URL for browser execution");
  }

  return `${baseUrl}${normalizedPath}`;
}

function hasJsonBody(method: ApiEndpointMethod): boolean {
  return method !== "GET" && method !== "DELETE";
}

export function ApiEndpointPlayground({
  title,
  description,
  method,
  path,
  expectedResponse,
  requestBodyExample,
  apiKeys,
  apiBaseUrl,
  defaultOpen = false,
}: ApiEndpointPlaygroundProps) {
  const defaultApiBaseUrl = useMemo(getDefaultApiBaseUrl, []);
  const effectiveApiBaseUrl = (apiBaseUrl ?? defaultApiBaseUrl ?? "").replace(/\/$/, "");
  const [selectedApiKeyId, setSelectedApiKeyId] = useState<string>(
    apiKeys[0]?.id ?? CUSTOM_KEY_OPTION_ID
  );
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [attachedApiKey, setAttachedApiKey] = useState<string | null>(null);
  const [requestBodyText, setRequestBodyText] = useState<string>(() => {
    if (!hasJsonBody(method) || requestBodyExample === undefined) {
      return "";
    }
    return prettyJson(requestBodyExample);
  });
  const [isExecuting, setIsExecuting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [executeError, setExecuteError] = useState<string | null>(null);
  const [executionResult, setExecutionResult] = useState<ExecutionResult | null>(null);
  const [isOpen, setIsOpen] = useState(defaultOpen);

  const bodyEnabled = hasJsonBody(method);
  const selectedApiKeyMeta = apiKeys.find((apiKey) => apiKey.id === selectedApiKeyId) ?? null;
  const selectedApiKeyPrefix = selectedApiKeyMeta?.keyPrefix ?? null;
  const isCustomApiKeySelection = selectedApiKeyId === CUSTOM_KEY_OPTION_ID;

  useEffect(() => {
    if (isCustomApiKeySelection) {
      setAttachedApiKey(null);
      return;
    }

    const stored = getStoredApiKeySecret({
      apiKeyId: selectedApiKeyId,
      keyPrefix: selectedApiKeyPrefix,
    });

    setAttachedApiKey(stored);
    setApiKeyInput(stored ?? "");
  }, [isCustomApiKeySelection, selectedApiKeyId, selectedApiKeyPrefix]);

  const fetchSnippet = useMemo(() => {
    const normalizedPath = formatPath(path);
    const isAbsolute = normalizedPath.startsWith("http://") || normalizedPath.startsWith("https://");
    const targetExpression = isAbsolute
      ? `"${normalizedPath}"`
      : "`" + "${API_BASE_URL}" + `${normalizedPath}` + "`";

    const headerLines = ['Authorization: `Bearer ${API_KEY}`', '"Content-Type": "application/json"'];

    let bodyLine = "";
    if (bodyEnabled && requestBodyText.trim()) {
      const parsed = tryParseJson(requestBodyText);
      if (typeof parsed === "string") {
        bodyLine = `,\n  body: JSON.stringify(${JSON.stringify(parsed)})`;
      } else {
        bodyLine = `,\n  body: JSON.stringify(${prettyJson(parsed)})`;
      }
    }

    return [
      "const API_BASE_URL = " + JSON.stringify(effectiveApiBaseUrl || "https://api.example.com") + ";",
      "const API_KEY = \"<paste_api_key_here>\";",
      "",
      `const response = await fetch(${targetExpression}, {`,
      `  method: "${method}",`,
      `  headers: { ${headerLines.join(", ")} }${bodyLine},`,
      "});",
      "",
      "const payload = await response.json();",
      "console.log(payload);",
    ].join("\n");
  }, [bodyEnabled, effectiveApiBaseUrl, method, path, requestBodyText]);

  const onCopyFetch = async () => {
    try {
      await navigator.clipboard.writeText(fetchSnippet);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const onAttachSelectedKey = () => {
    if (isCustomApiKeySelection) {
      return;
    }

    const normalized = normalizeApiKeyInput(apiKeyInput);
    if (!normalized) {
      setExecuteError("Paste the full key value before attaching it to the selected key.");
      return;
    }
    if (!normalized.startsWith("sk_test_") && !normalized.startsWith("sk_live_")) {
      setExecuteError("Invalid API key format. Paste the raw key value (sk_test_... or sk_live_...).");
      return;
    }

    storeApiKeySecret({
      value: normalized,
      apiKeyId: selectedApiKeyId,
      keyPrefix: selectedApiKeyPrefix,
    });
    setAttachedApiKey(normalized);
    setApiKeyInput(normalized);
    setExecuteError(null);
  };

  const onExecute = async () => {
    setExecuteError(null);
    setExecutionResult(null);

    const normalizedInput = normalizeApiKeyInput(apiKeyInput);
    const apiKey = isCustomApiKeySelection
      ? normalizedInput
      : normalizedInput || normalizeApiKeyInput(attachedApiKey ?? "");

    if (!apiKey) {
      setExecuteError(
        isCustomApiKeySelection
          ? "API key value is required to execute a request."
          : "No key is attached to the selected API key. Paste it once and click Attach selected key."
      );
      return;
    }
    if (!apiKey.startsWith("sk_test_") && !apiKey.startsWith("sk_live_")) {
      setExecuteError("Invalid API key format. Paste the raw key value (sk_test_... or sk_live_...).");
      return;
    }
    if (!isCustomApiKeySelection) {
      storeApiKeySecret({
        value: apiKey,
        apiKeyId: selectedApiKeyId,
        keyPrefix: selectedApiKeyPrefix,
      });
      setAttachedApiKey(apiKey);
    }

    let parsedBody: unknown;
    if (bodyEnabled && requestBodyText.trim()) {
      try {
        parsedBody = JSON.parse(requestBodyText);
      } catch {
        setExecuteError("Request body must be valid JSON.");
        return;
      }
    }

    const startedAt = Date.now();
    setIsExecuting(true);

    try {
      const response = await fetch(resolveEndpointUrl(path, effectiveApiBaseUrl), {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: parsedBody !== undefined ? JSON.stringify(parsedBody) : undefined,
      });

      const text = await response.text();
      const payload = text ? tryParseJson(text) : {};

      setExecutionResult({
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        durationMs: Date.now() - startedAt,
        body: payload,
      });
    } catch (error) {
      setExecuteError(error instanceof Error ? error.message : "Request execution failed.");
    } finally {
      setIsExecuting(false);
    }
  };

  return (
    <Card className="border-[rgba(28,28,29,0.14)]">
      <CardHeader className="gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="rounded-full border border-[rgba(28,28,29,0.16)] bg-[rgba(28,28,29,0.04)] px-2 py-0.5 text-xs font-semibold">
              {method}
            </span>
            <code className="truncate rounded bg-[rgba(28,28,29,0.05)] px-2 py-1 text-xs">
              {formatPath(path)}
            </code>
          </div>
          <div className="flex items-center gap-2">
            {isOpen ? (
              <>
                <Button type="button" variant="secondary" size="sm" onClick={onCopyFetch}>
                  {copied ? <Check className="mr-1 h-4 w-4" /> : <Copy className="mr-1 h-4 w-4" />}
                  Copy as fetch
                </Button>
                <Button type="button" size="sm" onClick={onExecute} disabled={isExecuting}>
                  {isExecuting ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  ) : (
                    <Play className="mr-1 h-4 w-4" />
                  )}
                  Execute
                </Button>
              </>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setIsOpen((current) => !current)}
              aria-expanded={isOpen}
              aria-label={isOpen ? "Collapse endpoint details" : "Expand endpoint details"}
            >
              <ChevronDown
                className={`h-4 w-4 transition-transform ${isOpen ? "rotate-180" : "rotate-0"}`}
              />
            </Button>
          </div>
        </div>
        <CardTitle className="text-base">{title}</CardTitle>
        {isOpen ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>

      {isOpen ? (
        <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2">
            <Label>API key selector</Label>
            <Select value={selectedApiKeyId} onValueChange={setSelectedApiKeyId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select API key profile" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={CUSTOM_KEY_OPTION_ID}>Custom API key</SelectItem>
                {apiKeys.map((apiKey) => (
                  <SelectItem key={apiKey.id} value={apiKey.id}>
                    {apiKey.name} ({apiKey.keyPrefix})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedApiKeyMeta ? (
              <p className="text-xs text-[rgba(28,28,29,0.64)]">
                {selectedApiKeyMeta.environment} · {selectedApiKeyMeta.role}
              </p>
            ) : (
              <p className="text-xs text-[rgba(28,28,29,0.64)]">
                Use any active API key from the API keys page.
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label>API key value</Label>
            <Input
              type="password"
              value={apiKeyInput}
              onChange={(event) => setApiKeyInput(event.currentTarget.value)}
              placeholder="Paste secret key value (shown once at creation/rotation)"
              autoComplete="off"
            />
            {isCustomApiKeySelection ? (
              <p className="text-xs text-[rgba(28,28,29,0.64)]">
                Custom mode uses this value directly for execution.
              </p>
            ) : (
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-[rgba(28,28,29,0.64)]">
                  {attachedApiKey
                    ? "A key is attached to this selection. Run executes a real authenticated call."
                    : "No key attached yet. Paste the full key and attach it once."}
                </p>
                <Button type="button" size="sm" variant="secondary" onClick={onAttachSelectedKey}>
                  Attach selected key
                </Button>
              </div>
            )}
          </div>
        </div>

        {bodyEnabled ? (
          <div className="space-y-2">
            <Label>Request body (JSON)</Label>
            <textarea
              className="focus-visible:border-ring focus-visible:ring-ring/50 min-h-[152px] w-full rounded-md border border-[rgba(28,28,29,0.18)] bg-transparent p-3 font-mono text-xs leading-5 outline-none focus-visible:ring-[3px]"
              value={requestBodyText}
              onChange={(event) => setRequestBodyText(event.currentTarget.value)}
              spellCheck={false}
            />
          </div>
        ) : null}

        <div className="grid gap-3 lg:grid-cols-2">
          <div className="space-y-2">
            <Label>Expected response</Label>
            <pre className="max-h-[280px] overflow-auto rounded-lg border border-[rgba(28,28,29,0.14)] bg-[rgba(28,28,29,0.03)] p-3 text-xs leading-5 text-[rgba(28,28,29,0.82)]">
              <code>{prettyJson(expectedResponse)}</code>
            </pre>
          </div>

          <div className="space-y-2">
            <Label>Last execution</Label>
            {executeError ? (
              <div className="rounded-lg border border-[#c71f37]/25 bg-[#c71f37]/[0.04] p-3 text-xs text-[#8a1f2a]">
                {executeError}
              </div>
            ) : executionResult ? (
              <div className="space-y-2">
                <p className="text-xs text-[rgba(28,28,29,0.72)]">
                  Status: {executionResult.status} {executionResult.statusText} ·{" "}
                  {executionResult.durationMs}ms
                </p>
                <pre className="max-h-[280px] overflow-auto rounded-lg border border-[rgba(28,28,29,0.14)] bg-[rgba(28,28,29,0.03)] p-3 text-xs leading-5 text-[rgba(28,28,29,0.82)]">
                  <code>{prettyJson(executionResult.body)}</code>
                </pre>
              </div>
            ) : (
              <div className="rounded-lg border border-[rgba(28,28,29,0.14)] bg-[rgba(28,28,29,0.02)] p-3 text-xs text-[rgba(28,28,29,0.64)]">
                Run Execute to inspect live API output.
              </div>
            )}
          </div>
        </div>
      </CardContent>
      ) : null}
    </Card>
  );
}
