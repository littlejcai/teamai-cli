// [teamai-desktop] Additive structured read layer. Never calls autoDetectInit,
// migrate helpers or getRepoStatus (the latter fetches and writes the clone).
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import YAML from 'yaml';
import simpleGit from 'simple-git';
import { LocalConfigSchema, TeamaiConfigSchema, getDataHome, type LocalConfig } from './types.js';
import { scanTeamRepoNamespaces } from './resources/skills.js';
import { getAllHandlers } from './resources/index.js';
import { loadRolesManifest } from './roles.js';
import { loadProjectsManifest } from './projects.js';

export interface DesktopContext { scope: 'user' | 'project'; projectRoot: string; home?: string }
async function exists(p: string) { return fs.access(p).then(() => true, () => false); }
async function yaml(p: string) { return YAML.parse(await fs.readFile(p, 'utf8')); }
function same(a: string, b: string) {
  const norm = (p: string) => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
  return norm(a) === norm(b);
}
/** Locate existing configuration by anchors; no partition creation or renaming. */
export async function desktopConfig(ctx: DesktopContext) {
  const home = ctx.home ?? os.homedir();
  let configPath = path.join(home, '.teamai', 'config.yaml');
  if (ctx.scope === 'project') {
    let anchor = ctx.projectRoot;
    try {
      const gitDir = (await simpleGit(ctx.projectRoot).raw(['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
      anchor = path.dirname(gitDir);
    } catch { /* non-git workspaces use legacy config */ }
    const root = path.join(home, '.teamai', 'projects');
    const parts = await fs.readdir(root).catch(() => [] as string[]);
    const matches: string[] = [];
    for (const name of parts) {
      const dir = path.join(root, name);
      const stored = await fs.readFile(path.join(dir, 'anchor'), 'utf8').catch(() => '');
      if (stored.trim() && same(stored.trim(), anchor)) matches.push(path.join(dir, 'config.yaml'));
    }
    if (matches.length > 1) throw new Error('Multiple project partitions match this workspace; repair the anchors before continuing.');
    configPath = matches[0] ?? path.join(ctx.projectRoot, '.teamai', 'config.yaml');
  }
  if (!await exists(configPath)) return null;
  const config: LocalConfig = LocalConfigSchema.parse(await yaml(configPath));
  if (config.scope !== ctx.scope) throw new Error('Configuration scope does not match selected context.');
  if (ctx.scope === 'project') { config.projectRoot = ctx.projectRoot; config.dataHome = path.dirname(configPath); }
  const team = TeamaiConfigSchema.parse(await yaml(path.join(config.repo.localPath, 'teamai.yaml')));
  return { configPath, config, team };
}
export async function desktopSnapshot(ctx: DesktopContext) {
  const loaded = await desktopConfig(ctx);
  if (!loaded) return { state: 'uninitialized' as const, resources: [], changes: [], roles: [], namespaces: [] };
  const { config, team, configPath } = loaded;
  const resources: Array<{ name: string; type: string; source: string; path: string }> = [];
  const changes: Array<{ name: string; type: string; path: string; status: string; before?: string }> = [];
  for (const handler of getAllHandlers()) {
    for (const item of await handler.scanTeamForPull(team, config)) {
      if(handler.type==='env')continue;
      resources.push({ name: item.name, type: handler.type, source: 'repo', path: item.sourcePath });
    }
    for (const item of await handler.scanLocalForPush(team, config)) {
      changes.push({ name: item.name, type: handler.type, path: item.sourcePath, status: item.status ?? 'modified' });
      if (handler.type!=='env' && !resources.some(r => r.path === item.sourcePath)) resources.push({ name: item.name, type: handler.type, source: 'local', path: item.sourcePath });
    }
  }
  let git: { ahead: number; behind: number; modified: string[]; error?: string };
  try {
    const raw = await simpleGit(config.repo.kind === 'self' ? config.repo.businessRepoRoot! : config.repo.localPath).raw(['--no-pager','--no-optional-locks','status','--porcelain=v1','--branch','-z']);
    const entries=raw.split('\0');const branch=entries.shift()??'';const modified:string[]=[];
    for(let i=0;i<entries.length;i++){const entry=entries[i];if(!entry)continue;modified.push(entry.slice(3));if(/[RC]/.test(entry.slice(0,2)))i++;}
    git = { ahead: Number(branch.match(/ahead (\d+)/)?.[1]??0), behind: Number(branch.match(/behind (\d+)/)?.[1]??0), modified };
  } catch (e) { git = { ahead: 0, behind: 0, modified: [], error: (e as Error).message }; }
  const teamFile='teamai.yaml';const gitRoot=config.repo.kind==='self'?config.repo.businessRepoRoot!:config.repo.localPath;
  const teamRelative=path.relative(gitRoot,path.join(config.repo.localPath,teamFile)).replaceAll('\\','/');
  const teamConfigChanged=git.modified.some(p=>p.replaceAll('\\','/')===teamRelative);
  if(teamConfigChanged){const file=path.join(config.repo.localPath,'teamai.yaml');resources.push({name:'teamai.yaml',type:'config',source:'repo',path:file});const before=await simpleGit(gitRoot).raw(['--no-pager','show',`HEAD:${teamRelative}`]).catch(()=>'');changes.push({name:'teamai.yaml',type:'config',path:file,status:'modified',before});}
  const roles = await loadRolesManifest(config.repo.localPath).catch(e => {
    if (String(e).includes('not found')) return null; throw e;
  });
  const projects = await loadProjectsManifest(config.repo.localPath);
  const state = JSON.parse(await fs.readFile(path.join(getDataHome(config), 'state.json'), 'utf8').catch(() => '{}'));
  return {
    state: 'ready' as const, configPath, repoPath: config.repo.localPath, remote: config.repo.remote,
    username: config.username, role: config.primaryRole, scope: config.scope, git,
    lastPull: state.lastPull ?? null, lastPush: state.lastPush ?? null,
    // [teamai-desktop] Read existing contribution receipts and deployment locations only.
    pendingPushes: state.pendingPushes ?? [],
    toolTargets: Object.entries(team.toolPaths).filter(([agent]) =>
      config.enabledAgents ? config.enabledAgents.includes(agent as never) : !config.disabledAgents?.includes(agent as never)
    ).map(([agent, paths]) => ({ agent, skills: paths.skills ? path.resolve(config.scope === 'project' ? config.projectRoot! : (ctx.home ?? os.homedir()), paths.skills) : null })),
    resources, changes, roles: roles?.roles ?? [], projects: projects?.projects ?? [],
    namespaces: [...new Set([...(roles?.roles.flatMap(r => r.resources.skills) ?? []),...await scanTeamRepoNamespaces(config.repo.localPath)])],
    needsMigration: Boolean(roles && !config.primaryRole), enabledAgents: config.enabledAgents ?? [],
  };
}
/** Inspect a temporary clone owned by the desktop application. */
export async function desktopManifest(repoPath: string) {
  const team = TeamaiConfigSchema.parse(await yaml(path.join(repoPath, 'teamai.yaml')));
  const roles = await loadRolesManifest(repoPath).catch(e => { if (String(e).includes('not found')) return null; throw e; });
  const projects = await loadProjectsManifest(repoPath);
  return { roles: roles?.roles ?? [], projects: projects?.projects ?? [], provider: team.provider };
}
