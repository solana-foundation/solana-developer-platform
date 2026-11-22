export interface InjectionRequest {
  // The request target as it is sent: path, then an optional query.
  path: string;
  // The body as it is sent; empty when the request has none.
  body: string;
}

export type AuthHeaders = Record<string, string>;

export type AuthInjection<Credential> = (
  credential: Credential,
  request: InjectionRequest
) => AuthHeaders | Promise<AuthHeaders>;
