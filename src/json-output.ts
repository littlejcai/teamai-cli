// [teamai-desktop] JSON output layer — machine-readable output for GUI clients
// (TeamAI Desktop). Policy: new files + minimal wiring only; kernel logic is
// never modified. See ADR-0001 in the TeamAi-Desktop repo and docs/CORE.md.
//
// Usage:
//   - Entry points call setJsonMode() (+ setSilent(true) from utils/logger) when
//     the user passed --json, then their implementation either emits a payload
//     via emitJson() or records dry-run plan entries via recordDryRunEntry().
//   - Payloads are versioned with a top-level `schema` envelope so GUI clients
//     can evolve independently of the CLI.

/** Envelope version — bump on breaking payload shape changes. */
export const JSON_OUTPUT_SCHEMA = 'teamai-json/v1';

let jsonMode = false;
const dryRunPlan: DryRunPlanEntry[] = [];

/** One "would sync" entry recorded during `pull --dry-run --json`. */
export interface DryRunPlanEntry {
  /** Scope label the entry belongs to (user / project / inherited-user). */
  scope: string;
  /** Resource type (skills / rules / docs / env / agents / hooks / mcp). */
  type: string;
  /** How many items would be synced. */
  count: number;
  /** Names that would be newly installed (when computed). */
  added?: string[];
  /** Names that would be updated in place (when computed). */
  updated?: string[];
  /** How many items were excluded by the team tag subscription filter. */
  skippedByTags?: number;
}

export function setJsonMode(): void {
  jsonMode = true;
}

export function isJsonMode(): boolean {
  return jsonMode;
}

/** Print a payload as the command's only stdout output. */
export function emitJson(payload: Record<string, unknown>): void {
  console.log(JSON.stringify({ schema: JSON_OUTPUT_SCHEMA, ...payload }, null, 2));
}

/** Record one pull --dry-run plan entry (no-op outside JSON mode). */
export function recordDryRunEntry(entry: DryRunPlanEntry): void {
  if (jsonMode) dryRunPlan.push(entry);
}

/** Drain the collected dry-run plan (pull() may cover multiple scopes). */
export function takeDryRunPlan(): DryRunPlanEntry[] {
  return dryRunPlan.splice(0, dryRunPlan.length);
}

/**
 * Reset all module state. Test helper only — the layer is process-global and
 * commander registers handlers once per process, so real commands never need it.
 */
export function resetJsonStateForTests(): void {
  jsonMode = false;
  dryRunPlan.length = 0;
}
