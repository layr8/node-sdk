// What makes "re-running a release is always safe" true.
//
// The claim used to rest on a read: `npm view @layr8/sdk@<v>` before
// publishing. The registry is not read-your-writes (see
// wait-for-npm-version.test.ts), so inside that window a re-drive reads "not
// published", publishes, and is refused with EPUBLISHCONFLICT — a red release
// for a version that is on npm. `scripts/publish-if-absent.sh` lets the
// registry decide instead of asking it to remember.
//
// npm is stubbed on PATH, so nothing here touches the network or publishes.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("../scripts/publish-if-absent.sh", import.meta.url).pathname;

let dir: string;

/**
 * A fake `npm` recording each call.
 *
 * @param view   what `npm view` does: "found" (the version is on the
 *               registry) or "missing".
 * @param publish what `npm publish` does: "ok", "conflict"
 *               (EPUBLISHCONFLICT), or "broken" (any other failure).
 */
function stubNpm(view: "found" | "missing", publish: "ok" | "conflict" | "broken"): void {
  const script = `#!/usr/bin/env bash
echo "$@" >> "${join(dir, "calls.log")}"
case "$1" in
  view)
    ${view === "found" ? 'echo "0.4.9"; exit 0' : 'echo "npm error code E404" >&2; exit 1'}
    ;;
  publish)
    ${
      publish === "ok"
        ? 'echo "+ @layr8/sdk@0.4.9"; exit 0'
        : publish === "conflict"
          ? 'echo "npm error code EPUBLISHCONFLICT" >&2; echo "npm error Cannot publish over previously published version 0.4.9." >&2; exit 1'
          : 'echo "npm error code ENEEDAUTH" >&2; exit 1'
    }
    ;;
esac
`;
  const path = join(dir, "npm");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
}

function run(version: string): { status: number; out: string } {
  try {
    const out = execFileSync("bash", [SCRIPT, version, "--access", "public"], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
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

describe("publish-if-absent.sh", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "npm-publish-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("publishes when the registry does not have the version", () => {
    stubNpm("missing", "ok");
    const { status } = run("0.4.9");
    expect(status).toBe(0);
    expect(calls()).toEqual(["view @layr8/sdk@0.4.9 version", "publish --access public"]);
  });

  it("skips the publish when the registry already has the version", () => {
    stubNpm("found", "ok");
    const { status, out } = run("0.4.9");
    expect(status).toBe(0);
    expect(out).toContain("already on the registry");
    expect(calls()).toEqual(["view @layr8/sdk@0.4.9 version"]);
  });

  // The re-drive inside the read-your-writes window. The read misses, the
  // publish is refused, and the version IS on npm — which is what the release
  // needed. Before this, the job went red and the release had to be driven
  // again by hand.
  it("treats the registry's duplicate refusal as published", () => {
    stubNpm("missing", "conflict");
    const { status, out } = run("0.4.9");
    expect(status).toBe(0);
    expect(out).toContain("EPUBLISHCONFLICT");
    expect(out).toContain("Treating as published");
  });

  // The tolerance is narrow on purpose: only "this version already exists"
  // is an acceptable failure. Everything else is a release that did not
  // happen, and must stay red.
  it("still fails on any other publish failure", () => {
    stubNpm("missing", "broken");
    const { status, out } = run("0.4.9");
    expect(status).toBe(1);
    expect(out).toContain("ENEEDAUTH");
    expect(out).not.toContain("Treating as published");
  });

  it("refuses to run without a version rather than publishing something unnamed", () => {
    stubNpm("missing", "ok");
    let status = 0;
    try {
      execFileSync("bash", [SCRIPT], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
        stdio: "ignore",
      });
    } catch (e) {
      status = (e as { status: number }).status;
    }
    expect(status).toBe(2);
    expect(calls()).toEqual([]);
  });
});
