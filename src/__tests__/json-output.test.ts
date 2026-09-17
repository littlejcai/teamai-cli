// [teamai-desktop] Snapshot tests for the JSON output layer (json-output.ts,
// json-status.ts + the per-command wiring). All kernel deps are mocked; the
// captured stdout is separator-normalized so snapshots are portable across
// Windows/POSIX runners.
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

// ── Hoisted mock state ───────────────────────────────────
const mocks = vi.hoisted(() => ({
    skillsScan: vi.fn(),
    skillsLocal: vi.fn(),
    contributors: vi.fn(),
    docsCount: vi.fn(),
    agentsScan: vi.fn(),
    agentsLocal: vi.fn(),
    hooksCount: vi.fn(),
    parseMcp: vi.fn(),
    resolveTargets: vi.fn(),
    buildVars: vi.fn(),
    getRepoStatus: vi.fn(),
    loadStateForScope: vi.fn(),
    autoDetectInit: vi.fn(),
    detectProjectConfig: vi.fn(),
    requireInit: vi.fn(),
    listFilesRecursive: vi.fn(),
    listDirs: vi.fn(),
    pathExists: vi.fn(),
    readFileSafe: vi.fn(),
    listFiles: vi.fn(),
    readJson: vi.fn(),
    parseTeamMcp: vi.fn(),
    parseHooksYaml: vi.fn(),
    parseTeamHooks: vi.fn(),
    getHookStatus: vi.fn(),
    detectInstalledAgents: vi.fn(),
    buildClassifyContext: vi.fn(),
    scanAgentSkills: vi.fn(),
    projectsRootDir: vi.fn(),
    readAnchorFile: vi.fn(),
}));

// ── Module mocks ─────────────────────────────────────────

vi.mock('../config.js', () => ({
    autoDetectInit: mocks.autoDetectInit,
    loadStateForScope: mocks.loadStateForScope,
    detectProjectConfig: mocks.detectProjectConfig,
    requireInit: mocks.requireInit,
}));

vi.mock('../utils/git.js', () => ({
    getRepoStatus: mocks.getRepoStatus,
    pullRepo: vi.fn(),
}));

vi.mock('../utils/fs.js', () => ({
    listFilesRecursive: mocks.listFilesRecursive,
    listDirs: mocks.listDirs,
    pathExists: mocks.pathExists,
    readFileSafe: mocks.readFileSafe,
    listFiles: mocks.listFiles,
    readJson: mocks.readJson,
}));

vi.mock('../utils/partition.js', () => ({
    projectsRootDir: mocks.projectsRootDir,
    readAnchorFile: mocks.readAnchorFile,
    projectSlug: (p: string) => p.split('/').pop(),
    legacyProjectSlug: (p: string) => `legacy-${p}`,
}));

vi.mock('../resources/index.js', () => ({
    getAllHandlers: () => [
        { type: 'skills', scanTeamForPull: mocks.skillsScan, scanLocalForPush: mocks.skillsLocal },
        { type: 'agents', scanTeamForPull: mocks.agentsScan, scanLocalForPush: mocks.agentsLocal },
        {
            type: 'hooks',
            scanTeamForPull: vi.fn(async () => []),
            scanLocalForPush: vi.fn(async () => []),
            countHooks: mocks.hooksCount,
        },
    ],
    getHandler: vi.fn(),
}));

vi.mock('../resources/skills.js', () => ({
    SkillsHandler: class {
        scanTeamForPull = mocks.skillsScan;
        scanLocalForPush = mocks.skillsLocal;
        static readContributors = mocks.contributors;
    },
}));

vi.mock('../resources/docs.js', () => ({
    DocsHandler: class {
        countDocFiles = mocks.docsCount;
    },
}));

vi.mock('../resources/mcp.js', () => ({
    parseTeamMcpServers: mocks.parseMcp,
}));

vi.mock('../resources/hooks.js', () => ({
    parseHooksYaml: mocks.parseHooksYaml,
    parseTeamHooks: mocks.parseTeamHooks,
}));

vi.mock('../resources/env.js', () => ({
    maskEnvValue: () => '***MASKED***',
}));

vi.mock('../utils/path-safety.js', () => ({
    assertSafeResourceName: vi.fn(),
}));

vi.mock('../known-agents.js', () => ({
    detectInstalledAgents: mocks.detectInstalledAgents,
}));

vi.mock('../agent-skills.js', () => ({
    buildClassifyContext: mocks.buildClassifyContext,
    scanAgentSkills: mocks.scanAgentSkills,
    classifySkill: vi.fn(),
    formatSkillSource: vi.fn((s: string) => s),
    truncate: vi.fn((s?: string) => s ?? ''),
}));

vi.mock('../mcp-reconcile.js', () => ({
    resolveMcpTargets: mocks.resolveTargets,
    buildVarTable: mocks.buildVars,
}));

vi.mock('../hooks.js', () => ({
    getHookStatus: mocks.getHookStatus,
    reconcileHooksToAllTools: vi.fn(),
    reconcileTeamHooksForConfig: vi.fn(),
    sweepLegacyProjectHooks: vi.fn(),
    hasInstalledCodexTrustGatedTool: vi.fn(),
    codexTrustReminder: vi.fn(),
}));

vi.mock('../builtin-hooks.js', () => ({
    builtinHookDefs: () => [
        { event: 'SessionStart', command: 'node hook-dispatch.js --bg-only' },
        { event: 'Stop', matcher: '*', command: 'node hook-dispatch.js' },
    ],
}));

vi.mock('../utils/logger.js', () => ({
    log: { info: vi.fn(), success: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dim: vi.fn() },
    setSilent: vi.fn(),
    setVerbose: vi.fn(),
    spinner: vi.fn(),
}));

vi.mock('../utils/reports-branch.js', () => ({
    refreshReportsWorktree: vi.fn(),
    ensureReportsWorktree: vi.fn(async () => '/tmp/repo'),
}));

// ── Imports (after mocks) ────────────────────────────────

import {
    emitJson,
    isJsonMode,
    setJsonMode,
    recordDryRunEntry,
    takeDryRunPlan,
    resetJsonStateForTests,
} from '../json-output.js';
import { status, list } from '../status.js';
import { listMembers } from '../members.js';
import { mcpList } from '../mcp-cmd.js';
import { hooksList } from '../hooks-cmd.js';
import { managedMcpManifestKey } from '../types.js';

// ── Fixtures ─────────────────────────────────────────────

const mockLocalConfig = {
    repo: { localPath: '/tmp/repo', remote: 'https://example.com/team/repo.git', kind: 'http' },
    username: 'alice',
    updatePolicy: 'auto',
    scope: 'user',
};

const mockTeamConfig = {
    toolPaths: {
        claude: { settings: '.claude/settings.json', skills: '.claude/skills' },
        cursor: { settings: '.cursor/hooks.json', skills: '.cursor/skills' },
    },
};

function mockHome(home: string): () => void {
    const original = process.env.HOME;
    process.env.HOME = home;
    return () => {
        if (original === undefined) delete process.env.HOME;
        else process.env.HOME = original;
    };
}

/** Capture stdout produced by emitJson (console.log) as parsed payloads. */
async function captureConsole(fn: () => Promise<void>): Promise<string> {
    const out: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => {
        out.push(String(m));
    });
    try {
        await fn();
    } finally {
        spy.mockRestore();
    }
    return out.join('\n');
}

/** Separator-normalize so snapshots are portable across Windows/POSIX.
 *  Handles: path.join() backslashes, displayPath home-abbreviation on either
 *  platform, and double slashes left over after backslash folding. */
function normalize(s: string): string {
    return s
        .replace(/\\/g, '/')
        .replace(/(?<!:)\/{2,}/g, '/')
        .replace(/\/home\/testuser/g, '~');
}

beforeEach(() => {
    resetJsonStateForTests();
    vi.clearAllMocks();
    mocks.autoDetectInit.mockResolvedValue({ localConfig: mockLocalConfig, teamConfig: mockTeamConfig });
    mocks.loadStateForScope.mockResolvedValue({ lastPush: '2026-01-01T00:00:00.000Z', lastPull: null });
    mocks.getRepoStatus.mockResolvedValue({ ahead: 0, behind: 0, modified: [] });
    mocks.skillsScan.mockResolvedValue([{ name: 's1', sourcePath: '/tmp/repo/skills/s1' }]);
    mocks.skillsLocal.mockResolvedValue([]);
    mocks.contributors.mockResolvedValue(['alice']);
    mocks.docsCount.mockResolvedValue(3);
    mocks.agentsScan.mockResolvedValue([]);
    mocks.agentsLocal.mockResolvedValue([]);
    mocks.hooksCount.mockResolvedValue(2);
    mocks.parseMcp.mockResolvedValue([]);
    mocks.parseHooksYaml.mockResolvedValue(null);
    mocks.parseTeamMcp.mockResolvedValue([]);
    mocks.listFilesRecursive.mockResolvedValue([]);
    mocks.pathExists.mockResolvedValue(false);
    mocks.readFileSafe.mockResolvedValue(null);
    mocks.listFiles.mockResolvedValue([]);
    mocks.readJson.mockResolvedValue({});
    mocks.parseTeamHooks.mockResolvedValue([]);
    mocks.getHookStatus.mockResolvedValue('missing');
    mocks.detectInstalledAgents.mockResolvedValue([]);
    mocks.resolveTargets.mockResolvedValue([]);
    mocks.buildVars.mockResolvedValue({});
});

afterEach(() => {
    // vitest restores spies; console spies restore in captureConsole finally.
});

// ── Infra ────────────────────────────────────────────────

describe('json-output infra', () => {
    it('emitJson wraps payloads in a schema envelope', async () => {
        const out = await captureConsole(async () => emitJson({ command: 'x', n: 1 }));
        expect(JSON.parse(out)).toEqual({ schema: 'teamai-json/v1', command: 'x', n: 1 });
    });

    it('recordDryRunEntry is a no-op until JSON mode is on, and takeDryRunPlan drains', () => {
        recordDryRunEntry({ scope: 'user', type: 'skills', count: 1 });
        expect(takeDryRunPlan()).toEqual([]);

        setJsonMode();
        expect(isJsonMode()).toBe(true);
        recordDryRunEntry({ scope: 'user', type: 'skills', count: 2, added: ['a'] });
        recordDryRunEntry({ scope: 'user', type: 'docs', count: 3 });
        expect(takeDryRunPlan()).toEqual([
            { scope: 'user', type: 'skills', count: 2, added: ['a'] },
            { scope: 'user', type: 'docs', count: 3 },
        ]);
        expect(takeDryRunPlan()).toEqual([]);
    });
});

// ── hooks list --json ────────────────────────────────────

describe('hooks list --json', () => {
    it('emits per-tool status, builtin and team hooks', async () => {
        setJsonMode();
        const restoreHome = mockHome('/home/testuser');
        mocks.getHookStatus.mockResolvedValue('installed');
        mocks.parseTeamHooks.mockResolvedValue([
            { source: 'team', key: 'lint', event: 'Stop', command: 'npm run lint', description: 'x', tools: ['claude'], roles: ['devops'] },
        ]);
        let out: string;
        try {
            out = await captureConsole(() => hooksList({}));
        } finally {
            restoreHome();
        }
        const payload = JSON.parse(out);
        expect(payload.schema).toBe('teamai-json/v1');
        expect(payload.command).toBe('hooks');
        expect(payload.tools).toEqual([
            { tool: 'claude', status: 'installed', settingsPath: expect.any(String) },
            { tool: 'cursor', status: 'installed', settingsPath: expect.any(String) },
        ]);
        expect(normalize(JSON.stringify(payload))).toMatchSnapshot();
    });
});

// ── members --json ───────────────────────────────────────

describe('members --json', () => {
    it('emits the parsed roster with isSelf marks', async () => {
        setJsonMode();
        mocks.detectProjectConfig.mockResolvedValue(mockLocalConfig);
        mocks.listFiles.mockResolvedValue(['alice.yaml', 'bob.yaml']);
        mocks.readFileSafe.mockImplementation(async (_p: string) => {
            // second file is an invalid member — must be skipped silently
            return _p.endsWith('alice.yaml')
                ? 'username: alice\ndisplayName: Alice\nregisteredAt: "2026-01-01T00:00:00.000Z"\nrole: dev\nprojects: [proj1]'
                : 'not: valid member';
        });
        const out = await captureConsole(() => listMembers({}));
        const payload = JSON.parse(out);
        expect(payload.command).toBe('members');
        expect(payload.count).toBe(1);
        expect(payload.members[0]).toMatchObject({ username: 'alice', isSelf: true, role: 'dev', projects: ['proj1'] });
        expect(normalize(out)).toMatchSnapshot();
    });

    it('emits an empty roster when no member files exist', async () => {
        setJsonMode();
        mocks.detectProjectConfig.mockResolvedValue(mockLocalConfig);
        const out = await captureConsole(() => listMembers({}));
        expect(JSON.parse(out)).toEqual({ schema: 'teamai-json/v1', command: 'members', count: 0, members: [] });
    });
});

// ── mcp list --json ──────────────────────────────────────

describe('mcp list --json', () => {
    it('emits servers with secrets + install state and detected tools', async () => {
        setJsonMode();
        mocks.parseMcp.mockResolvedValue([
            { name: 'ctx7', transport: 'stdio', command: 'npx', args: ['-y', 'ctx7'], description: 'docs lookup', roles: ['dev'] },
            { name: 'http-srv', transport: 'http', url: 'https://mcp.example.com', description: null, roles: null },
        ]);
        mocks.resolveTargets.mockResolvedValue([
            { tool: 'claude', file: '/home/testuser/.claude/mcp.json', projectScope: undefined },
        ]);
        mocks.buildVars.mockResolvedValue({ GITHUB_TOKEN: 'x' });
        // ctx7 already installed in claude → manifest lookup must find it
        mocks.readJson.mockResolvedValue({
            [managedMcpManifestKey('claude', undefined)]: [{ name: 'ctx7' }],
        });
        const out = await captureConsole(() => mcpList({}));
        const payload = JSON.parse(out);
        expect(payload.command).toBe('mcp');
        expect(payload.servers[0].installedIn).toEqual(['claude']);
        expect(payload.servers[1].endpoint).toBe('https://mcp.example.com');
        expect(normalize(out)).toMatchSnapshot();
    });

    it('emits empty lists when no team MCP servers are defined', async () => {
        setJsonMode();
        const out = await captureConsole(() => mcpList({}));
        expect(JSON.parse(out)).toEqual({ schema: 'teamai-json/v1', command: 'mcp', servers: [], tools: [] });
    });
});

// ── status --json ────────────────────────────────────────

describe('status --json', () => {
    it('emits scope, git state, resource counts and unpushed locals', async () => {
        setJsonMode();
        const restoreHome = mockHome('/home/testuser');
        mocks.getRepoStatus.mockResolvedValue({ ahead: 2, behind: 0, modified: ['skills/a/SKILL.md'] });
        mocks.pathExists.mockImplementation(async (p: string) => p.endsWith('env.yaml'));
        mocks.readFileSafe.mockImplementation(async (p: string) =>
            p.endsWith('env.yaml') ? 'variables:\n  - key: GITHUB_TOKEN\n    value: secret-value\n' : null,
        );
        mocks.skillsLocal.mockResolvedValue([{ name: 'my-new-skill' }]);
        let out: string;
        try {
            out = await captureConsole(() => status({}));
        } finally {
            restoreHome();
        }
        const payload = JSON.parse(out);
        expect(payload.command).toBe('status');
        expect(payload.scope).toBe('user');
        expect(payload.repo.ahead).toBe(2);
        expect(payload.resources).toEqual({ skills: 1, rules: 0, docs: 3, env: 1, agents: 0, hooks: 2, mcp: 0 });
        expect(payload.localUnpushed).toEqual([{ type: 'skills', count: 1, names: ['my-new-skill'] }]);
        expect(normalize(out)).toMatchSnapshot();
    });

    it('status --all --json enumerates partitions with verdicts', async () => {
        setJsonMode();
        const restoreHome = mockHome('/home/testuser');
        mocks.projectsRootDir.mockReturnValue('/home/testuser/.teamai/projects');
        mocks.listDirs.mockResolvedValue(['active', 'gone']);
        mocks.readAnchorFile.mockImplementation(async (dir: string) =>
            dir.endsWith('active') ? '/repos/active' : '/repos/gone',
        );
        mocks.pathExists.mockImplementation(async (p: string) => p === '/repos/active');
        mocks.readFileSafe.mockResolvedValue(null);
        const out = await captureConsole(() => status({ all: true }));
        const payload = JSON.parse(out);
        expect(payload.command).toBe('status');
        expect(payload.scope).toBe('all');
        expect(payload.orphanCount).toBe(1);
        expect(payload.partitions).toEqual([
            { slug: 'active', state: 'active', projectPath: '/repos/active', scope: null, kind: null },
            { slug: 'gone', state: 'orphan', projectPath: '/repos/gone', scope: null, kind: null },
        ]);
        expect(normalize(out)).toMatchSnapshot();
    });
});

// ── list --json ──────────────────────────────────────────

describe('list --json', () => {
    it('emits repo sections for every resource type', async () => {
        setJsonMode();
        const restoreHome = mockHome('/home/testuser');
        mocks.parseMcp.mockResolvedValue([
            { name: 'ctx7', transport: 'stdio', command: 'npx', args: ['-y', 'ctx7'], url: undefined, description: 'docs' },
        ]);
        mocks.parseHooksYaml.mockResolvedValue({
            hooks: [{ id: 'on-stop', event: 'Stop', description: 'team stop hook' }],
        });
        mocks.pathExists.mockImplementation(async (p: string) => p.endsWith('env.yaml'));
        mocks.readFileSafe.mockImplementation(async (p: string) =>
            p.endsWith('env.yaml') ? 'variables:\n  - key: GITHUB_TOKEN\n    value: secret-value\n    description: github token\n' : null,
        );
        let out: string;
        try {
            out = await captureConsole(() => list(undefined, {}));
        } finally {
            restoreHome();
        }
        const payload = JSON.parse(out);
        expect(payload.command).toBe('list');
        expect(payload.source).toBe('all');
        expect(payload.repo.skills).toEqual([{ name: 's1', path: '/tmp/repo/skills/s1', contributors: ['alice'] }]);
        expect(payload.repo.env).toEqual([
            { key: 'GITHUB_TOKEN', value: '***MASKED***', revealed: false, description: 'github token' },
        ]);
        expect(payload.repo.mcp[0]).toMatchObject({ name: 'ctx7', transport: 'stdio', endpoint: 'npx -y ctx7' });
        expect(payload.repo.hooks).toEqual([{ id: 'on-stop', event: 'Stop', description: 'team stop hook' }]);
        expect(normalize(out)).toMatchSnapshot();
    });

    it('reports validation errors in-band and sets a non-zero exit code', async () => {
        setJsonMode();
        let out = await captureConsole(() => list('nope', {}));
        const payload = JSON.parse(out);
        expect(payload.error).toContain('Unknown resource type: nope');
        expect(process.exitCode).toBe(1);
        process.exitCode = 0;
    });
});
