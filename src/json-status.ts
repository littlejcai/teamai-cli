// [teamai-desktop] JSON payload builders for `status` / `status --all` / `list`.
// Re-invokes the same kernel APIs the human-readable commands in status.ts use,
// so shapes stay in sync with the CLI output. Policy: this file must remain
// additive — no edits to kernel files. Snapshot tests pin these shapes.
import path from 'node:path';
import YAML from 'yaml';
import { autoDetectInit, loadStateForScope } from './config.js';
import { getRepoStatus } from './utils/git.js';
import { assertSafeResourceName } from './utils/path-safety.js';
import { getAllHandlers } from './resources/index.js';
import { listDirs, listFilesRecursive, pathExists, readFileSafe } from './utils/fs.js';
import { SkillsHandler } from './resources/skills.js';
import { DocsHandler } from './resources/docs.js';
import { detectInstalledAgents } from './known-agents.js';
import { buildClassifyContext, scanAgentSkills } from './agent-skills.js';
import {
  RESOURCE_TYPES,
  LocalConfigSchema,
  getDataHome,
  type GlobalOptions,
  type ResourceType,
} from './types.js';
import { projectsRootDir, readAnchorFile, projectSlug, legacyProjectSlug } from './utils/partition.js';
import { maskEnvValue } from './resources/env.js';
import { parseTeamMcpServers } from './resources/mcp.js';
import { parseHooksYaml } from './resources/hooks.js';
import type { ListOptions } from './status.js';

type ScopeConfigs = Awaited<ReturnType<typeof autoDetectInit>>;

/** Payload for `teamai status --json` (single scope). */
export async function buildStatusPayload(options: GlobalOptions): Promise<Record<string, unknown>> {
  const { localConfig, teamConfig } = await autoDetectInit();

  let git: Record<string, unknown>;
  try {
    const s = await getRepoStatus(localConfig.repo.localPath);
    git = {
      remote: localConfig.repo.remote,
      localPath: localConfig.repo.localPath,
      ahead: s.ahead,
      behind: s.behind,
      modified: s.modified,
      upToDate: s.ahead === 0 && s.behind === 0 && s.modified.length === 0,
    };
  } catch (e) {
    git = { remote: localConfig.repo.remote, localPath: localConfig.repo.localPath, error: (e as Error).message };
  }

  const state = await loadStateForScope(localConfig);

  // Resource counts — mirror status() ordering and semantics exactly.
  const repoPath = localConfig.repo.localPath;
  const counts: Record<string, number> = {};
  counts.skills = (await new SkillsHandler().scanTeamForPull(teamConfig, localConfig)).length;
  counts.rules = (await listFilesRecursive(path.join(repoPath, 'rules'))).filter((f) => f.endsWith('.md')).length;
  counts.docs = await new DocsHandler().countDocFiles(path.join(repoPath, 'docs'));
  let envCount = 0;
  const envYamlPath = path.join(repoPath, 'env', 'env.yaml');
  if (await pathExists(envYamlPath)) {
    const envContent = await readFileSafe(envYamlPath);
    if (envContent) {
      try {
        const envData = YAML.parse(envContent) as { variables?: unknown[] };
        envCount = Array.isArray(envData?.variables) ? envData.variables.length : 0;
      } catch {
        // invalid yaml
      }
    }
  }
  counts.env = envCount;
  const agentsHandler = getAllHandlers().find((h) => h.type === 'agents');
  counts.agents = agentsHandler ? (await agentsHandler.scanTeamForPull(teamConfig, localConfig)).length : 0;
  const hooksHandler = getAllHandlers().find((h) => h.type === 'hooks') as
    | { countHooks: (repoPath: string) => Promise<number> }
    | undefined;
  counts.hooks = hooksHandler ? await hooksHandler.countHooks(repoPath) : 0;
  counts.mcp = (await parseTeamMcpServers(repoPath)).length;

  const resources: Record<string, number> = {};
  for (const type of RESOURCE_TYPES) resources[type] = counts[type] ?? 0;

  // Local items not yet pushed — JSON always carries names (GUI renders them).
  const localUnpushed: Array<{ type: string; count: number; names: string[] }> = [];
  for (const handler of getAllHandlers()) {
    const items = await handler.scanLocalForPush(teamConfig, localConfig);
    if (items.length > 0) {
      localUnpushed.push({ type: handler.type, count: items.length, names: items.map((i) => i.name) });
    }
  }

  return {
    command: 'status',
    scope: localConfig.scope,
    projectRoot: localConfig.projectRoot ?? null,
    dataHome: getDataHome(localConfig),
    repo: git,
    state: { lastPush: state.lastPush ?? null, lastPull: state.lastPull ?? null },
    resources,
    localUnpushed,
    verbose: options.verbose ?? false,
  };
}

/** Payload for `teamai status --all --json` — every project data partition. */
export async function buildStatusAllPayload(): Promise<Record<string, unknown>> {
  const root = projectsRootDir();
  const slugs = (await listDirs(root)).sort();

  const partitions: Array<Record<string, unknown>> = [];
  let orphanCount = 0;

  for (const slug of slugs) {
    const partitionDir = path.join(root, slug);
    const anchor = await readAnchorFile(partitionDir);

    let projectPath: string | null = anchor;
    let scope: string | undefined;
    let kind: string | undefined;
    const cfgRaw = await readFileSafe(path.join(partitionDir, 'config.yaml'));
    if (cfgRaw) {
      try {
        const parsed = LocalConfigSchema.parse(YAML.parse(cfgRaw));
        scope = parsed.scope;
        kind = parsed.repo.kind;
        if (!projectPath) projectPath = parsed.repo.businessRepoRoot ?? parsed.projectRoot ?? null;
      } catch {
        /* unreadable config — leave fields undefined */
      }
    }

    // Verdict logic mirrors statusAll() in status.ts — anchor is the only
    // trustworthy orphan signal; config paths are display fallbacks.
    let state: string;
    if (!anchor) {
      state = projectPath ? 'unknown' : 'unknown (no anchor / project path)';
    } else if (!(await pathExists(anchor))) {
      state = 'orphan';
      orphanCount++;
    } else if (projectSlug(anchor) === slug) {
      state = 'active';
    } else if (legacyProjectSlug(anchor) === slug) {
      state = 'active (legacy name)';
    } else {
      state = 'corrupt';
    }

    partitions.push({ slug, state, projectPath: projectPath ?? null, scope: scope ?? null, kind: kind ?? null });
  }

  return { command: 'status', scope: 'all', partitionsRoot: root, partitions, orphanCount };
}

/** Payload for `teamai list [type] --json`. */
export async function buildListPayload(
  type: string | undefined,
  options: ListOptions,
): Promise<Record<string, unknown>> {
  const { localConfig, teamConfig } = await autoDetectInit();
  const repoPath = localConfig.repo.localPath;

  const source = options.source ?? 'all';
  if (!['repo', 'local', 'all'].includes(source)) {
    return { command: 'list', error: `Invalid --source: ${source}. Must be one of: repo, local, all.` };
  }
  // Same traversal guard as the human path (list() in status.ts).
  if (options.agent != null) {
    try {
      assertSafeResourceName(options.agent);
    } catch (err) {
      return { command: 'list', error: `Invalid --agent: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  const isSkillsScope = !type || type === 'skills';
  if ((options.agent || source === 'local') && !isSkillsScope) {
    return { command: 'list', error: '--source local / --agent only apply when listing skills.' };
  }
  if (type && !RESOURCE_TYPES.includes(type as ResourceType)) {
    return { command: 'list', error: `Unknown resource type: ${type}. Supported: ${RESOURCE_TYPES.join(', ')}` };
  }

  const types: ResourceType[] = type ? [type as ResourceType] : [...RESOURCE_TYPES];

  const payload: Record<string, unknown> = { command: 'list', source, types };

  if (source === 'repo' || source === 'all') {
    const repo: Record<string, unknown> = {};
    for (const t of types) repo[t] = await buildRepoSection(t, options, repoPath, teamConfig, localConfig);
    payload.repo = repo;
  }

  if ((source === 'local' || source === 'all') && isSkillsScope) {
    payload.localAgents = await buildLocalAgentsSection(options, localConfig, teamConfig);
  }

  return payload;
}

/** One REPO section — mirrors printRepoSection() semantics. */
async function buildRepoSection(
  t: ResourceType,
  options: ListOptions,
  repoPath: string,
  teamConfig: ScopeConfigs['teamConfig'],
  localConfig: ScopeConfigs['localConfig'],
): Promise<unknown> {
  if (t === 'env') {
    const envYamlPath = path.join(repoPath, 'env', 'env.yaml');
    if (!(await pathExists(envYamlPath))) return [];
    const envContent = await readFileSafe(envYamlPath);
    if (!envContent) return [];
    try {
      const envData = YAML.parse(envContent) as { variables?: Array<{ key: string; value: string; description?: string }> };
      return (envData?.variables ?? []).map((v) => ({
        key: v.key,
        value: options.reveal ? v.value : maskEnvValue(v.value),
        revealed: !!options.reveal,
        description: v.description ?? null,
      }));
    } catch {
      return { error: 'invalid env.yaml' };
    }
  }

  if (t === 'mcp') {
    const servers = await parseTeamMcpServers(repoPath);
    return servers.map((s) => ({
      name: s.name,
      transport: s.transport,
      endpoint: s.transport === 'stdio' ? `${s.command ?? ''} ${(s.args ?? []).join(' ')}`.trim() : (s.url ?? ''),
      description: s.description ?? null,
    }));
  }

  if (t === 'hooks') {
    const parsed = await parseHooksYaml(repoPath);
    return (parsed?.hooks ?? []).map((h) => ({
      id: h.id,
      event: h.event,
      description: h.description ?? null,
    }));
  }

  const handler = getAllHandlers().find((h) => h.type === t);
  if (!handler) return [];
  const items = await handler.scanTeamForPull(teamConfig, localConfig);
  return Promise.all(
    items.map(async (item) => ({
      name: item.name,
      path: item.sourcePath,
      contributors:
        t === 'skills' ? await SkillsHandler.readContributors(item.sourcePath) : undefined,
    })),
  );
}

/** LOCAL AGENTS section — mirrors printLocalAgentsSection(). */
async function buildLocalAgentsSection(
  options: ListOptions,
  localConfig: ScopeConfigs['localConfig'],
  teamConfig: ScopeConfigs['teamConfig'],
): Promise<unknown> {
  const allAgents = await detectInstalledAgents(localConfig, teamConfig);
  const agents = options.agent ? allAgents.filter((a) => a.id === options.agent) : allAgents;

  if (options.agent && agents.length === 0) {
    return { error: `Agent "${options.agent}" is unknown.` };
  }

  const ctx = await buildClassifyContext(localConfig);
  const views = [];
  for (const agent of agents.filter((a) => a.installed)) {
    views.push(await scanAgentSkills(agent, ctx));
  }

  return views.map((v) => ({
    id: v.agent.id,
    skillsPath: v.agent.absoluteSkillsPath,
    fromTeamConfig: v.agent.fromTeamConfig,
    skills: v.skills.map((s) => ({
      name: s.name,
      source: s.source,
      description: s.description ?? null,
    })),
  }));
}
