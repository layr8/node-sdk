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

import { DEFAULT_REST_TIMEOUT_MS } from "./config.js";

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

/**
 * Per-request options for a REST call.
 *
 * Named for the transport, not for `client.request()` — `RequestOptions` in
 * `client.ts` is the DIDComm request/response one, and two identically named
 * types describing unrelated things is how a caller ends up setting a field the
 * other one would have honoured.
 */
export interface RestRequestOptions {
  /**
   * Give up after this many milliseconds of socket INACTIVITY — not of total
   * elapsed time — rejecting with a timeout error and destroying the request.
   *
   * Overrides the client-wide default (`Config.restTimeoutMs`, 30s). `0`
   * disables the deadline for this call: the escape hatch for a call that is
   * expected to be slow, not an implementation detail.
   *
   * Inactivity is the whole point and also the sharp edge: while the node signs
   * or verifies, no bytes flow, so a genuinely slow sign counts as silence and
   * will hit the default. Raise it on THAT call rather than lifting the
   * deadline everywhere.
   */
  timeoutMs?: number;
}

/** Internal REST client for the cloud-node HTTP API. */
export class RestClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly defaultTimeoutMs: number;

  constructor(
    baseUrl: string,
    apiKey: string,
    /** Deadline applied to any call that does not carry its own — see `Config.restTimeoutMs`. */
    defaultTimeoutMs: number = DEFAULT_REST_TIMEOUT_MS,
  ) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  /** Send a JSON POST request and return the decoded response. */
  async post<T>(path: string, body: unknown, opts?: RestRequestOptions): Promise<T> {
    const data = JSON.stringify(body);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(data)),
    };
    if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
    }
    return this.request<T>("POST", path, headers, data, opts);
  }

  /** Send a GET request and return the decoded response. */
  async get<T>(path: string, opts?: RestRequestOptions): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
    }
    return this.request<T>("GET", path, headers, undefined, opts);
  }

  /** Execute an HTTP request using node:http with localhost resolution (RFC 6761). */
  private request<T>(
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: string,
    opts?: RestRequestOptions,
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

      // The deadline, enforced on the SOCKET.
      //
      // `http.request` has NO default timeout: a peer that completes the TCP
      // handshake and then says nothing leaves this promise pending forever,
      // and forever is a long time to hold a socket and whatever is queued
      // behind the caller. `setTimeout` alone only EMITS the event — the
      // request stays open unless it is destroyed — so the handler destroys it
      // with an error that names the deadline, rather than letting the caller
      // read "socket hang up" and go looking for a network fault.
      //
      // `??`, never `||`: `undefined` means "use the client's default", `0`
      // means "no deadline at all", and `0 || 30000` would silently turn the
      // one explicit way to opt out into the default.
      //
      // No teardown is needed when the response arrives. Node clears the
      // per-request timeout callback off the socket before returning it to the
      // agent's keep-alive pool, so a deadline set here cannot fire on a later
      // request that reuses the connection. Verified, not assumed — see the
      // "leaves no timer armed on a pooled connection" test.
      const timeoutMs = opts?.timeoutMs ?? this.defaultTimeoutMs;
      if (timeoutMs > 0) {
        req.setTimeout(timeoutMs, () => {
          req.destroy(new Error(`Request to ${path} timed out after ${timeoutMs}ms`));
        });
      }

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
