import { readAiResourceResponse } from "@/lib/ai-resources";

export const runtime = "nodejs";

export async function GET(req: Request) {
  return readAiResourceResponse("llms", req);
}
