/**
 * The note the new-request page leaves for the page it opens next: the request it made and
 * whether that request's link reached the clipboard, which the request's page says under the
 * link. It lives in this tab's memory and is written only by the create's press handler, in the
 * browser, so the server's copy of this module never holds one and a server render shows none.
 * A reload, another tab or a later visit finds nothing.
 */
let note: { requestId: string; linkCopied: boolean } | null = null;

/**
 * Leaves the note, replacing any earlier one.
 *
 * @param requestId - The request the new-request page just made.
 * @param linkCopied - Whether its pay link reached the clipboard.
 */
export function noteCreatedRequestLink(requestId: string, linkCopied: boolean): void {
  note = { requestId, linkCopied };
}

/**
 * @param requestId - The request whose page is opening.
 * @returns Whether the new-request page copied this request's link, or null when it did not
 *   just make this request.
 */
export function createdRequestLinkCopied(requestId: string): boolean | null {
  return note !== null && note.requestId === requestId ? note.linkCopied : null;
}

/** Drops the note, once a request's page has opened: it is for the first arrival only. */
export function forgetCreatedRequestLink(): void {
  note = null;
}
