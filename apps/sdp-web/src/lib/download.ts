export function filenameFromContentDisposition(
  disposition: string | null,
  fallback: string
): string {
  return /filename="([^"]+)"/.exec(disposition ?? "")?.[1] ?? fallback;
}

export async function downloadResponseBlob(response: Response, fallbackFilename: string) {
  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");

  try {
    link.href = href;
    link.download = filenameFromContentDisposition(
      response.headers.get("Content-Disposition"),
      fallbackFilename
    );
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    URL.revokeObjectURL(href);
  }
}
