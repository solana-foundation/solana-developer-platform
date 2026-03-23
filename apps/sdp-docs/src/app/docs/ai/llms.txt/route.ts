import { readAiResourceResponse } from "@/lib/ai-resources";

export const runtime = "nodejs";

export async function GET() {
  return readAiResourceResponse("llms");
}
