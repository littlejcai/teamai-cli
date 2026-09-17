// [teamai-desktop] The library entry must expose the GUI surface WITHOUT
// executing the CLI: src/index.ts runs program.parse() at module scope, so if
// desktop-api.ts ever accidentally re-exports/reaches the CLI entry, importing
// this module would error on vitest's argv (and hang on interactive menus).
import { describe, it, expect } from 'vitest';
import * as api from '../desktop-api.js';

describe('desktop-api library entry', () => {
    it('exposes JSON payload builders', () => {
        expect(typeof api.buildStatusPayload).toBe('function');
        expect(typeof api.buildStatusAllPayload).toBe('function');
        expect(typeof api.buildListPayload).toBe('function');
        expect(api.JSON_OUTPUT_SCHEMA).toBe('teamai-json/v1');
    });

    it('exposes core operations', () => {
        expect(typeof api.pull).toBe('function');
        expect(typeof api.status).toBe('function');
        expect(typeof api.list).toBe('function');
        expect(typeof api.listMembers).toBe('function');
        expect(typeof api.mcpList).toBe('function');
        expect(typeof api.hooksList).toBe('function');
        expect(typeof api.autoDetectInit).toBe('function');
        expect(typeof api.ensureAstReady).toBe('function');
    });
});
