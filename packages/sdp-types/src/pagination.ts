/**
 * Result of a server-side paginated fetch: the page of items plus the total
 * count across all pages, with a success flag and optional error message.
 */
export interface PaginatedResponse<T> {
  ok: boolean;
  data: T[];
  total: number;
  error?: string;
}
