export interface AuthRequest {
  // The request target as it is sent: path, then an optional query.
  path: string;
  // The body as it is sent; empty when the request has none.
  body: string;
}

export type AuthHeaders = Record<string, string>;

export abstract class AuthService<Credential> {
  abstract injectCredentials(
    credential: Credential,
    request: AuthRequest
  ): AuthHeaders | Promise<AuthHeaders>;
}
