import { describe, it, expect } from "vitest";
import { listScenarios } from "../bin/compat.js";

describe("CLI adapter", () => {
  it("lists available scenarios", () => {
    const scenarios = listScenarios();
    expect(scenarios).toContain("echo");
    expect(scenarios).toContain("pass");
    expect(scenarios).toContain("wildcard");
    expect(scenarios).toContain("disconnected");
    // types.ts should be excluded
    expect(scenarios).not.toContain("types");
  });
});