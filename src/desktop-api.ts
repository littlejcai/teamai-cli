// [teamai-desktop] Library entry for GUI clients (TeamAI Desktop).
// tsup builds this as a SECOND bundle (dist/desktop-api.js) so Electron can
// `import('teamai-cli/dist/desktop-api.js')` WITHOUT executing the CLI —
// src/index.ts calls program.parse() at module scope and must stay the CLI-only
// entry. Policy: additive re-exports only; no kernel logic here.
export {
    ensureAstReady,
    getParser,
    getLanguage,
    getQuery,
    grammarForExtension,
} from './wiki-engine/code-knowledge/ast/parser-registry.js';

// JSON output layer (teamai-json/v1)
export { buildStatusPayload, buildStatusAllPayload, buildListPayload } from './json-status.js';
export {
    setJsonMode,
    isJsonMode,
    emitJson,
    recordDryRunEntry,
    takeDryRunPlan,
    JSON_OUTPUT_SCHEMA,
} from './json-output.js';

// Core operations (same functions the CLI actions delegate to)
export { autoDetectInit } from './config.js';
export { pull } from './pull.js';
export { status, list } from './status.js';
export { listMembers } from './members.js';
export { mcpList, mcpInject } from './mcp-cmd.js';
export { hooksList, hooksInject } from './hooks-cmd.js';

export type { GlobalOptions } from './types.js';
