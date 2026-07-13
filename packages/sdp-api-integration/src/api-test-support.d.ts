declare module "@sdp/api/test-support" {
  type ApiTestStatement = {
    all<T = any>(): Promise<{ results: T[] }>;
    bind(...args: any[]): ApiTestStatement;
    first<T = any>(): Promise<T | null>;
    run(): Promise<any>;
  };

  type ApiTestDatabase = {
    prepare(query: string): ApiTestStatement;
  };

  export type ApiTestEnv = any;
  export type ApiTestCustodyWallet = any;

  export const apiTestSupport: {
    app: { request: (...args: any[]) => Promise<Response> };
    clearTestDatabase: (...args: any[]) => Promise<void>;
    closeDatabasePools: (...args: any[]) => Promise<void>;
    createMosaicService: (...args: any[]) => any;
    createOrgSigner: (...args: any[]) => Promise<any>;
    createSigningService: (...args: any[]) => any;
    createToken2022Service: (...args: any[]) => any;
    CustodyConfigStore: new (...args: any[]) => any;
    KoraAdapter: new (...args: any[]) => any;
    KoraClient: new (...args: any[]) => any;
    seedTestDatabase: (...args: any[]) => Promise<void>;
    TEST_ORG: Record<string, any>;
    getDb: (...args: any[]) => ApiTestDatabase;
    TEST_PROJECT: Record<string, any>;
    TEST_PROJECT_API_KEY: Record<string, any>;
    TEST_PROJECT_CACHED_KEY: Record<string, any>;
    TEST_USER: Record<string, any>;
  };
}
