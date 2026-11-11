/** A JSON request that throws a readable error, with a timeout. */
export class HttpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function request(url, { method = "GET", headers = {}, body, timeoutMs = 30_000, fetcher = fetch } = {}) {
  const init = { method, headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(timeoutMs) };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetcher(url, init);
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text.slice(0, 300) };
  }
  if (!response.ok) {
    const where = new URL(url);
    throw new HttpError(`${method} ${where.host}${where.pathname} answered ${response.status}: ${data.error ?? text.slice(0, 200)}`, response.status);
  }
  return data;
}
