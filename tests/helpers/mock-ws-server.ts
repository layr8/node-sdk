// Shared plumbing for the WebSocket mock servers used across the test suite.
//
// Never guess a port. vitest runs test files in parallel and each file starts
// many mock servers; picking a random port per server made EADDRINUSE
// collisions inevitable across hundreds of draws. Bind to port 0 instead and
// let the kernel hand out a free ephemeral port, then read the real port back
// once the server is listening.

import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";

/** A WebSocketServer bound to a kernel-assigned ephemeral port. */
export function ephemeralServer(): WebSocketServer {
  return new WebSocketServer({ port: 0 });
}

/**
 * Resolve with the kernel-assigned port once `wss` is listening.
 *
 * Binding is not synchronous, so `wss.address()` is only meaningful after the
 * `listening` event — mock servers must await this before handing out a URL.
 */
export function listeningPort(wss: WebSocketServer): Promise<number> {
  const portOf = (): number => (wss.address() as AddressInfo).port;
  if (wss.address()) return Promise.resolve(portOf());
  return new Promise((resolve, reject) => {
    wss.once("listening", () => resolve(portOf()));
    wss.once("error", reject);
  });
}

/** The Phoenix socket URL a client should connect to for a bound mock server. */
export function phoenixUrl(port: number): string {
  return `ws://127.0.0.1:${port}/plugin_socket/websocket`;
}

/**
 * Bind `wss` and return its Phoenix socket URL. The one call every mock
 * server's `ready()` needs.
 */
export async function readyUrl(wss: WebSocketServer): Promise<string> {
  return phoenixUrl(await listeningPort(wss));
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
