/**
 * Shared types for compat scenarios.
 * Matches the contract defined by the compat-suite orchestrator.
 */

export interface ScenarioContext {
  nodeUrl: string;
  apiKey: string;
  testId: string;
  timeout: number;
  agentDid?: string;
}

export interface SenderContext extends ScenarioContext {
  receiverDid: string;
}

export interface ScenarioResult {
  status: "pass" | "fail";
  scenario: string;
  duration_ms: number;
  error?: string | null;
}

export function elapsedMs(start: number): number {
  return Date.now() - start;
}