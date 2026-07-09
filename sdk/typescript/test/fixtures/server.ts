import { http, HttpResponse, type HttpHandler, type JsonBodyType } from "msw";
import { setupServer, type SetupServer } from "msw/node";

export const TEST_API_KEY = "bg_test_dummy";
export const TEST_BASE_URL = "https://api.test.budgetary.tools";

export interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface ServerHandle {
  server: SetupServer;
  requests: CapturedRequest[];
  reset(): void;
  use(...handlers: HttpHandler[]): void;
}

export function startTestServer(): ServerHandle {
  const requests: CapturedRequest[] = [];
  const server = setupServer();

  server.events.on("request:start", async ({ request }) => {
    const cloned = request.clone();
    const headers: Record<string, string> = {};
    cloned.headers.forEach((v, k) => {
      headers[k] = v;
    });
    let body: unknown = undefined;
    const text = await cloned.text();
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    requests.push({
      method: cloned.method,
      url: cloned.url,
      headers,
      body,
    });
  });

  return {
    server,
    requests,
    reset() {
      requests.length = 0;
      server.resetHandlers();
    },
    use(...handlers: HttpHandler[]) {
      server.use(...handlers);
    },
  };
}

export function jsonOk<T extends object>(
  path: string,
  body: T,
  init: ResponseInit = {},
): HttpHandler {
  return http.all(`${TEST_BASE_URL}${path}`, () =>
    HttpResponse.json(body, { status: 200, ...init }),
  );
}

export function jsonStatus(
  path: string,
  status: number,
  body: JsonBodyType,
  init: ResponseInit = {},
): HttpHandler {
  return http.all(`${TEST_BASE_URL}${path}`, () =>
    HttpResponse.json(body, { status, ...init }),
  );
}

export { http, HttpResponse };
