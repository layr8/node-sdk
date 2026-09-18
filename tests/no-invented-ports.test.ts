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
// THE RULE IS STATED POSITIVELY, on purpose. An earlier version of this file
// hunted for the shapes it knew — `Math.random()` on a line that also said
// "port", and a non-zero digit literal after `port:` — and was bypassed by a
// three-line probe that used neither:
//
//   const BASE = 10000;
//   const chosen = BASE + Math.floor(Math.random() * 50000);
//   const wss = new WebSocketServer({ port: chosen });
//
// A guard written as a list of known-bad spellings is only ever as good as
// the list. `binds a port that is not literally 0` has no list: every bind
// argument is either `0` or a finding.

import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TESTS_DIR = new URL(".", import.meta.url).pathname;
const REPO_ROOT = join(TESTS_DIR, "..");

/**
 * Where a mock server can live.
 *
 * `src/` is NOT scanned, and that is a decision rather than an oversight: the
 * SDK connects, it never listens. Its only `port:` occurrences are the
 * destination of an outbound request (`src/rest.ts` — `parsed.port || 443`),
 * where a non-zero port is the whole point and `0` would be meaningless. The
 * last test in this file checks that claim instead of trusting it, so `src/`
 * growing a server is a failure here rather than a silent hole.
 */
const SCANNED = ["tests", "compat"];

/** Every `.ts` file under `dir`, recursively. */
function sources(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

/**
 * The text a scan should judge: comments stripped, because this file's own
 * prose — and any comment that says "port:" — is not a bind. An earlier draft
 * flagged the comment `// Never guess a port: bind 0 and read back…`.
 */
function code(path: string): string {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .filter((line) => !/^\s*\*/.test(line))
    .join("\n");
}

/**
 * Every value given to a `port:` property, and every first argument to
 * `.listen(`. Captured rather than pattern-matched against known-bad
 * spellings: the value is then compared to `0`, so there is no list of bad
 * shapes to fall behind.
 */
function bindArguments(path: string): string[] {
  const text = code(path);
  return [
    ...[...text.matchAll(/port:\s*([^,;})\n]+)/g)].map((m) => m[1]),
    ...[...text.matchAll(/\.listen\(\s*([^,)\n]*)/g)].map((m) => m[1]),
  ].map((value) => value.trim());
}

/**
 * What a bind argument is allowed to be.
 *
 * `0` is the rule. `number` and `string` are type annotations, not binds:
 * `(server.address() as { port: number }).port` is how a test reads the
 * kernel's choice back, which is the behaviour being encouraged. The empty
 * string is `node.listen()` — a helper that binds 0 inside.
 */
const ALLOWED_BIND = new Set(["0", "number", "string", ""]);

/** Anything that starts a server, for the `src/` claim below. */
const BINDS_A_SERVER = /\.listen\(|new WebSocketServer\(|createServer\(/;

/** This file quotes the patterns it forbids, in prose and as regexes. */
const isThisFile = (path: string): boolean => path.endsWith("no-invented-ports.test.ts");

/** Each scanned file that binds something other than port 0, with the value. */
function offenders(files: string[]): string[] {
  return files.flatMap((f) =>
    isThisFile(f)
      ? []
      : bindArguments(f)
          .filter((value) => !ALLOWED_BIND.has(value))
          .map((value) => `${f}: port ${value}`),
  );
}

describe("mock servers never guess a port", () => {
  const files = SCANNED.flatMap((dir) => sources(join(REPO_ROOT, dir)));

  it("finds the test sources it is meant to scan", () => {
    // A walker that found nothing would pass every assertion below.
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.includes("/compat/"))).toBe(true);
  });

  it("every port it binds is literally 0", () => {
    expect(offenders(files)).toEqual([]);
  });

  // Defence in depth, and the shape the original defect had. The rules above
  // catch a computed port at the bind; this catches the arithmetic even when
  // the bind is spelled some way not yet imagined.
  it("computes no port from Math.random()", () => {
    const computed = files.filter(
      (f) =>
        !isThisFile(f) &&
        readFileSync(f, "utf8")
          .split("\n")
          .some((line) => /Math\.random\(\)/.test(line) && /port/i.test(line)),
    );
    expect(computed).toEqual([]);
  });

  // The reason `src/` is left out, checked rather than asserted.
  it("src/ still only connects, so leaving it unscanned stays correct", () => {
    const binding = sources(join(REPO_ROOT, "src")).filter((f) => BINDS_A_SERVER.test(code(f)));
    expect(binding).toEqual([]);
  });
});
