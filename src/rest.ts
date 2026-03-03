/**
 * Internal REST client for the Layr8 cloud-node HTTP API.
 *
 * Handles JSON serialization, API key authentication, and localhost resolution.
 */

/**
 * Derive the HTTP base URL from a WebSocket URL.
 *
 * ws://alice-test.localhost:4000/plugin_socket/websocket -> http://alice-test.localhost:4000
 * wss://alice-test.localhost/plugin_socket/websocket -> https://alice-test.localhost
 */
export function restUrlFromWebSocket(wsUrl: string): string {
  let u: URL;
  try {
    u = new URL(wsUrl);
  } catch {
    // Fallback: simple scheme replacement, strip path
    let s = wsUrl.replace("wss://", "https://").replace("ws://", "http://");
    const schemeEnd = s.indexOf("://");
    if (schemeEnd !== -1) {
      const pathStart = s.indexOf("/", schemeEnd + 3);
      if (pathStart !== -1) {
        s = s.slice(0, pathStart);
      }
    }
    return s;
  }

  switch (u.protocol) {
    case "wss:":
      u.protocol = "https:";
      break;
    default:
      u.protocol = "http:";
      break;
  }
  u.pathname = "";
  u.search = "";
  u.hash = "";
  return u.toString().replace(/\/$/, "");
}

/** RESTError represents an error response from the cloud-node REST API. */
export class RESTError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(`REST API error ${statusCode}: ${message}`);
    this.name = "RESTError";
    this.statusCode = statusCode;
  }
}

/** Internal REST client for the cloud-node HTTP API. */
export class RestClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  /** Send a JSON POST request and return the decoded response. */
  async post<T>(path: string, body: unknown): Promise<T> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
    }

    const resp = await fetch(this.baseUrl + path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    const respBody = await resp.text();

    if (resp.status >= 400) {
      throw parseRESTError(resp.status, respBody);
    }

    if (respBody.length > 0) {
      return JSON.parse(respBody) as T;
    }
    return undefined as unknown as T;
  }

  /** Send a GET request and return the decoded response. */
  async get<T>(path: string): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
    }

    const resp = await fetch(this.baseUrl + path, {
      method: "GET",
      headers,
    });

    const respBody = await resp.text();

    if (resp.status >= 400) {
      throw parseRESTError(resp.status, respBody);
    }

    if (respBody.length > 0) {
      return JSON.parse(respBody) as T;
    }
    return undefined as unknown as T;
  }
}

/** Parse an error response body into a RESTError. */
function parseRESTError(statusCode: number, body: string): RESTError {
  try {
    const parsed = JSON.parse(body) as { error?: string };
    if (parsed.error) {
      return new RESTError(statusCode, parsed.error);
    }
  } catch {
    // Not JSON; use raw body as message
  }
  return new RESTError(statusCode, body);
}
