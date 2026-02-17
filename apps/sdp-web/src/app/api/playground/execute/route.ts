import { sdpApiRequest } from "@/lib/sdp-api";
import { NextResponse } from "next/server";

type PlaygroundMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface PlaygroundExecuteRequestBody {
  method?: PlaygroundMethod;
  path?: string;
  body?: unknown;
  apiKey?: string | null;
}

const ALLOWED_METHODS = new Set<PlaygroundMethod>(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as PlaygroundExecuteRequestBody;
    const method = payload.method;
    const path = payload.path;

    if (!method || !ALLOWED_METHODS.has(method)) {
      return NextResponse.json({ error: "Invalid method" }, { status: 400 });
    }

    if (!path || typeof path !== "string") {
      return NextResponse.json({ error: "Invalid path" }, { status: 400 });
    }
    if (!path.startsWith("/")) {
      return NextResponse.json({ error: "Path must start with '/'" }, { status: 400 });
    }

    const normalizedApiKey = typeof payload.apiKey === "string" ? payload.apiKey.trim() : "";
    const headers: Record<string, string> = {};

    if (normalizedApiKey) {
      headers.Authorization = `Bearer ${normalizedApiKey}`;
    }

    const response = await sdpApiRequest(path, {
      method,
      headers,
      body:
        method !== "GET" && method !== "DELETE" && payload.body !== null && payload.body !== undefined
          ? JSON.stringify(payload.body)
          : undefined,
    });

    const text = await response.text();
    const body = text
      ? (() => {
          try {
            return JSON.parse(text) as unknown;
          } catch {
            return text;
          }
        })()
      : {};

    return NextResponse.json({
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      body,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Playground execution failed",
      },
      { status: 500 }
    );
  }
}
