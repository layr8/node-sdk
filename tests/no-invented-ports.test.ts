// A test that invents a port connects to whatever else happens to be
// listening on it. `tests/mediation.test.ts` drew `10000 + random*50000`,
// hit an unrelated plain-HTTP listener on a developer machine and failed
// with `Unexpected server response: 200` — a failure that says nothing
// about the SDK.
//
// The cure is always the same: bind port 0, let the kernel assign a free
// ephemeral port, and read it back once the server is listening
// (`tests/helpers/mock-ws-server.ts`).
//
// This guard lives in the suite it guards, so a new test file that invents
// a port goes red here rather than flaking once a month somewhere else.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TESTS_DIR = new URL(".", import.meta.url).pathname;

/** Every `.ts` file under `tests/`, including `helpers/`. */
function testSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return testSources(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

/**
 * Arithmetic that produces a port number. Deliberately narrow: it matches a
 * number combined with `Math.random()`, which is how every invented port in
 * this suite has been written.
 */
const INVENTED_PORT = /Math\.random\(\)[^\n]*(?:\*|\+)|(?:\*|\+)[^\n]*Math\.random\(\)/;

/** `new WebSocketServer({ port })` / `.listen(port` with a non-zero literal. */
const LITERAL_PORT = /(?:port:\s*(?!0\b)\d+)|(?:\.listen\(\s*(?!0\b)\d+)/;

describe("mock servers never guess a port", () => {
  const files = testSources(TESTS_DIR);

  it("finds the test sources it is meant to scan", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it("no test file computes a port from Math.random()", () => {
    const offenders = files.filter((f) => {
      // Skip this file: it contains the patterns as prose and as regexes.
      if (f.endsWith("no-invented-ports.test.ts")) return false;
      return readFileSync(f, "utf8")
        .split("\n")
        .some((line) => INVENTED_PORT.test(line) && /port/i.test(line));
    });
    expect(offenders).toEqual([]);
  });

  it("no test file binds a hard-coded port instead of 0", () => {
    const offenders = files.filter((f) => {
      if (f.endsWith("no-invented-ports.test.ts")) return false;
      return LITERAL_PORT.test(readFileSync(f, "utf8"));
    });
    expect(offenders).toEqual([]);
  });
});
