// Every workflow job that runs `npm test` must set up Bun first, with the same
// action version everywhere.
//
// tests/redact-connection-error.test.ts dials under Bun and fails, rather than
// skips, when CI has no Bun. #89 added the Bun step to ci.yaml only, so pull
// requests were green while the release chain's own `test` job could never
// pass: v0.4.10's first release run failed there and published nothing.
// This test reads the workflow files themselves, so a job that runs the suite
// without Bun fails here, on the pull request that introduces it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const REPO_ROOT = new URL("..", import.meta.url);
const WORKFLOWS = [".github/workflows/ci.yaml", ".github/workflows/release.yml"];
const SETUP_BUN = /^\s*uses:\s*(oven-sh\/setup-bun@\S+)\s*$/;
const RUNS_SUITE = /^\s*run:\s*npm test\s*$/;

interface JobSteps {
  file: string;
  job: string;
  lines: string[];
}

// Splits `jobs:` into its jobs by their two-space-indented keys. Enough for
// these two files; a job this cannot find is reported by the count check below.
function jobsOf(file: string): JobSteps[] {
  const text = readFileSync(new URL(file, REPO_ROOT), "utf8");
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l === "jobs:");
  if (start < 0) throw new Error(`${file} has no top-level jobs:`);
  const jobs: JobSteps[] = [];
  for (const line of lines.slice(start + 1)) {
    const key = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (key) jobs.push({ file, job: key[1], lines: [] });
    else if (/^\S/.test(line)) break;
    else jobs.at(-1)?.lines.push(line);
  }
  return jobs;
}

const suiteJobs = WORKFLOWS.flatMap(jobsOf).filter((j) =>
  j.lines.some((l) => RUNS_SUITE.test(l)),
);

describe("workflows that run the test suite set up Bun", () => {
  it("finds the suite in both ci.yaml and release.yml", () => {
    expect(new Set(suiteJobs.map((j) => j.file))).toEqual(new Set(WORKFLOWS));
  });

  it.each(suiteJobs.map((j) => [`${j.file} > ${j.job}`, j] as const))(
    "%s sets up Bun before npm test",
    (_name, j) => {
      const bunAt = j.lines.findIndex((l) => SETUP_BUN.test(l));
      const testAt = j.lines.findIndex((l) => RUNS_SUITE.test(l));
      expect(bunAt, `${j.file} job ${j.job} runs npm test without setting up Bun`).toBeGreaterThanOrEqual(0);
      expect(bunAt).toBeLessThan(testAt);
    },
  );

  it("uses one setup-bun version everywhere", () => {
    const versions = new Set(
      suiteJobs.flatMap((j) =>
        j.lines.map((l) => SETUP_BUN.exec(l)?.[1]).filter((v): v is string => !!v),
      ),
    );
    expect([...versions]).toHaveLength(1);
  });
});
