// [teamai-desktop] Real-filesystem contract: browse must not migrate or fetch.
import {it,expect} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import {execFileSync} from 'node:child_process';
import {desktopSnapshot} from '../desktop-read.js';
async function tree(root:string):Promise<Record<string,string>> {
 const out:Record<string,string>={};
 async function visit(dir:string){for(const entry of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,entry.name);if(entry.isDirectory())await visit(p);else out[path.relative(root,p)]=await fs.readFile(p,'utf8');}}
 await visit(root);return out;
}
it('distinguishes missing configuration from broken configuration without creating files',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'desktop-read-'));try{
  const ctx={scope:'project' as const,projectRoot:root,home:root};expect((await desktopSnapshot(ctx)).state).toBe('uninitialized');expect(await fs.readdir(root)).toEqual([]);
  await fs.mkdir(path.join(root,'.teamai'));await fs.writeFile(path.join(root,'.teamai/config.yaml'),'repo: not-an-object');
  await expect(desktopSnapshot(ctx)).rejects.toThrow();
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
it('returns real repo and local resources without changing config, resources or cache',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'desktop-read-'));try{
  const repo=path.join(root,'repo');await fs.mkdir(path.join(repo,'skills','sample'),{recursive:true});await fs.mkdir(path.join(root,'.teamai'));
  await fs.writeFile(path.join(repo,'skills/sample/SKILL.md'),'---\nname: sample\ndescription: fixture\n---\n# Example\n');
  await fs.writeFile(path.join(repo,'teamai.yaml'),YAML.stringify({team:'Fixture',repo:'https://example.com/team.git',provider:'git',toolPaths:{claude:{skills:'.claude/skills',rules:'.claude/rules'}}}));
  execFileSync('git',['init',repo]);execFileSync('git',['-C',repo,'add','.']);execFileSync('git',['-C',repo,'-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-m','fixture']);
  await fs.writeFile(path.join(root,'.teamai/config.yaml'),YAML.stringify({username:'fixture',scope:'project',projectRoot:root,repo:{localPath:repo,remote:'https://example.com/team.git'}}));
  await fs.writeFile(path.join(root,'.teamai/state.json'),JSON.stringify({pendingPushes:[{branch:'teamai/push/fixture/receipt',prUrl:null,createdAt:'2026-10-14',items:[]}]}));
  const before=await tree(root);const s=await desktopSnapshot({scope:'project',projectRoot:root,home:root});if(s.state==='ready'){expect(s.pendingPushes[0].branch).toBe('teamai/push/fixture/receipt');expect(s.toolTargets).toContainEqual({agent:'claude',skills:path.join(root,'.claude/skills')});}expect(s.state).toBe('ready');expect(s.resources).toEqual(expect.arrayContaining([expect.objectContaining({name:'sample',type:'skills',source:'repo'})]));expect(await tree(root)).toEqual(before);
  await fs.appendFile(path.join(repo,'teamai.yaml'),'description: Modified\n');const modified=await desktopSnapshot({scope:'project',projectRoot:root,home:root});expect(modified.changes).toEqual(expect.arrayContaining([expect.objectContaining({type:'config',name:'teamai.yaml'})]));expect(modified.changes.find(c=>c.type==='config')?.before).not.toContain('Modified');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

it('flags legacy role migration without rewriting configuration',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'desktop-legacy-'));try{
  const repo=path.join(root,'repo');await fs.mkdir(path.join(repo,'manifest'),{recursive:true});await fs.mkdir(path.join(root,'.teamai'));
  await fs.writeFile(path.join(repo,'teamai.yaml'),YAML.stringify({team:'Fixture',repo:'https://example.com/team.git',provider:'git',toolPaths:{}}));
  await fs.writeFile(path.join(repo,'manifest/roles.yaml'),YAML.stringify({version:1,roles:[{id:'hai',resources:{skills:['shared'],knowledge:['shared']}}]}));
  const config=YAML.stringify({username:'fixture',scope:'project',repo:{localPath:repo,remote:'https://example.com/team.git'}});await fs.writeFile(path.join(root,'.teamai/config.yaml'),config);
  await fs.writeFile(path.join(root,'.teamai/state.json'),JSON.stringify({pendingPushes:[{branch:'teamai/push/fixture/receipt',prUrl:null,createdAt:'2026-10-14',items:[]}]}));
  const before=await tree(root);const s=await desktopSnapshot({scope:'project',projectRoot:root,home:root});if(s.state==='ready'){expect(s.pendingPushes[0].branch).toBe('teamai/push/fixture/receipt');expect(s.toolTargets).toEqual([]);}expect(s.state).toBe('ready');if(s.state==='ready')expect(s.needsMigration).toBe(true);expect(await tree(root)).toEqual(before);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
