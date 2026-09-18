// The release chain's only defence against the registry not being
// read-your-writes. `publish-compat-image` runs `scripts/wait-for-npm-version.sh`
// before a Dockerfile that installs the version just published; if that script
// stops looking too early, or reports success without looking, the race that
// broke v0.4.9 comes straight back.
//
// The registry is stubbed by putting a fake `npm` first on PATH, so these
// assertions are about the script's own behaviour and make no network call.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("../scripts/wait-for-npm-version.sh", import.meta.url).pathname;

let dir: string;

/**
 * Write a fake `npm` that fails the first `failures` `npm view` calls and
 * succeeds afterwards, recording every call in `calls.log`.
 */
function stubNpm(failures: number): void {
  const script = `#!/usr/bin/env bash
echo "$@" >> "${join(dir, "calls.log")}"
COUNT=$(wc -l < "${join(dir, "calls.log")}" | tr -d ' ')
if [ "$COUNT" -le ${failures} ]; then
  echo "npm error code ETARGET" >&2
  exit 1
fi
echo "0.4.9"
`;
  const path = join(dir, "npm");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

function run(version: string, attempts: number): { status: number; out: string } {
  try {
    const out = execFileSync("bash", [SCRIPT, version], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        NPM_WAIT_ATTEMPTS: String(attempts),
        NPM_WAIT_DELAY: "0",
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { status: err.status, out: `${err.stdout}${err.stderr}` };
  }
}

function calls(): string[] {
  try {
    return readFileSync(join(dir, "calls.log"), "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

describe("wait-for-npm-version.sh", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "npm-wait-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps looking while the registry answers notarget, then succeeds", () => {
    // This is the v0.4.9 shape exactly: the publish landed, the first few
    // reads did not see it. Without the wait the build fails on the first.
    stubNpm(3);
    const { status, out } = run("0.4.9", 10);
    expect(status).toBe(0);
    expect(out).toContain("resolvable on the registry (attempt 4)");
    expect(calls()).toHaveLength(4);
  });

  it("stops looking once the version resolves", () => {
    stubNpm(0);
    const { status } = run("0.4.9", 10);
    expect(status).toBe(0);
    expect(calls()).toHaveLength(1);
  });

  it("fails, naming the version, when the version never appears", () => {
    // A release that genuinely did not publish must go red. An unbounded
    // wait would hang the job instead of saying what is wrong.
    stubNpm(99);
    const { status, out } = run("9.9.9", 3);
    expect(status).toBe(1);
    expect(out).toContain("@layr8/sdk@9.9.9");
    expect(out).toContain("not resolvable");
    expect(calls()).toHaveLength(3);
  });

  it("refuses to run without a version rather than waiting on nothing", () => {
    stubNpm(0);
    const { status } = run("", 3);
    expect(status).toBe(2);
    expect(calls()).toEqual([]);
  });
});
