interface Response {
  json<T = any>(): Promise<T>;
}
