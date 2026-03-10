/**
 * Internal REST client for the Layr8 cloud-node HTTP API.
 *
 * Handles JSON serialization, API key authentication, and localhost resolution.
 *
 * Uses Node's http/https modules instead of fetch because fetch (undici) does
 * not honor custom Host headers — required for *.localhost resolution (RFC 6761).
 */

import http from "node:http";
import https from "node:https";

/** Check whether a hostname is localhost or a subdomain of it (RFC 6761). */
function isLocalhost(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost");
}

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
    const data = JSON.stringify(body);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(data)),
    };
    if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
    }
    return this.request<T>("POST", path, headers, data);
  }

  /** Send a GET request and return the decoded response. */
  async get<T>(path: string): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
    }
    return this.request<T>("GET", path, headers);
  }

  /** Execute an HTTP request using node:http with localhost resolution (RFC 6761). */
  private request<T>(
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<T> {
    const parsed = new URL(this.baseUrl + path);
    const isHttps = parsed.protocol === "https:";
    const mod = isHttps ? https : http;

    // Resolve *.localhost to 127.0.0.1, preserving the original Host header.
    let hostname = parsed.hostname;
    if (isLocalhost(hostname)) {
      headers["Host"] = parsed.host;
      hostname = "127.0.0.1";
    }

    return new Promise<T>((resolve, reject) => {
      const req = mod.request(
        {
          hostname,
          port: parsed.port || (isHttps ? 443 : 80),
          path: parsed.pathname + parsed.search,
          method,
          headers,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const respBody = Buffer.concat(chunks).toString("utf-8");
            const status = res.statusCode ?? 0;

            if (status >= 400) {
              reject(parseRESTError(status, respBody));
              return;
            }

            if (respBody.length > 0) {
              try {
                resolve(JSON.parse(respBody) as T);
              } catch {
                reject(new Error(`Invalid JSON response: ${respBody}`));
              }
            } else {
              resolve(undefined as unknown as T);
            }
          });
        },
      );

      req.on("error", reject);

      if (body) {
        req.write(body);
      }
      req.end();
    });
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
