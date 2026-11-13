import { readFile } from "node:fs/promises";
import path from "node:path";
import { llmsForDeployment } from "./deployment-api";

type AiResourceName = "llms" | "llmsFull";

const aiResourceMap: Record<
  AiResourceName,
  {
    fileName: string;
    unavailableCode: string;
    unavailableMessage: string;
  }
> = {
  llms: {
    fileName: "llms.txt",
    unavailableCode: "LLMS_RESOURCE_UNAVAILABLE",
    unavailableMessage: "The generated llms.txt resource is not available.",
  },
  llmsFull: {
    fileName: "llms-full.txt",
    unavailableCode: "LLMS_FULL_RESOURCE_UNAVAILABLE",
    unavailableMessage: "The generated llms-full.txt resource is not available.",
  },
};

function getAiResourcePath(resourceName: AiResourceName): string {
  return path.join(process.cwd(), "public", aiResourceMap[resourceName].fileName);
}

export async function readAiResourceResponse(resourceName: AiResourceName) {
  const resource = aiResourceMap[resourceName];

  try {
    // The generated file is canonical; this deployment serves its own docs and API URLs.
    const body = llmsForDeployment(await readFile(getAiResourcePath(resourceName), "utf8"));

    return new Response(body, {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "public, max-age=300",
        "content-disposition": `inline; filename="${resource.fileName}"`,
      },
    });
  } catch {
    return Response.json(
      {
        error: {
          code: resource.unavailableCode,
          message: resource.unavailableMessage,
        },
      },
      { status: 503 }
    );
  }
}
