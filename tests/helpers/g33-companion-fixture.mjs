import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// The callable g33 companion adapter fixture shared by the suites that need a CONFIGURED adapter
// (tests/pjan-167-g33-companion.mjs, tests/pjan-166-config-authority-regressions.mjs). It proves
// PJangler's callable/CLI behaviour ONLY: it is deliberately not an owner installer, an owner API
// guess, or evidence of real g33 integration. `options.behavior` picks a failure mode.
export const COMPANION_ADAPTER_SOURCE = `
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
export async function companion(request) {
  const {operation,projectRoot,options}=request;
  if(request.schemaVersion!==1||request.moduleId!=='g33')throw new Error('wrong request contract');
  const content=join(projectRoot,'_bmad','g33','companion.md');
  const mapping=join(projectRoot,'_bmad','_config','g33-mapping.json');
  const expected='PJangler callable fixture companion\\n';
  const mapped='{"g33":"fixture reference"}\\n';
  const valid=existsSync(content)&&readFileSync(content,'utf8')===expected&&existsSync(mapping)&&readFileSync(mapping,'utf8')===mapped;
  const result=(status,summary,evidence=[])=>({schemaVersion:1,status,summary,details:['PJangler fixture only',request.reason],evidence,changedFiles:['fabricated-owner-path']});
  if(options.behavior==='unavailable')return result('unavailable','Owner source unavailable');
  if(options.behavior==='conflict')return result('conflict','Operator mapping conflict');
  if(options.behavior==='throw')throw new Error('Owner fixture threw');
  if(options.behavior==='metadata')return result(operation==='observe'?'installed':'unchanged','Metadata-only claim');
  if(options.behavior==='false-convergence')return result(operation==='observe'?'missing':'unchanged','False convergence',['metadata exists']);
  if(operation==='observe')return result(valid?'installed':'missing',valid?'Content and mappings observed':'Missing content or mapping',valid?['Exact companion bytes verified','Exact mapping bytes verified']:[]);
  if(operation==='plan')return result(valid?'unchanged':'planned',valid?'Companion converged':'Would reconcile fixture companion');
  if(operation!=='apply')throw new Error('unexpected operation');
  if(options.behavior==='no-op-apply')return result('unchanged','Did not actually install');
  for(const [path,text]of [[content,expected],[mapping,mapped]]){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,text);}
  return result('changed','Applied fixture companion');
}
`;

export function writeCompanionAdapter(path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, COMPANION_ADAPTER_SOURCE);
}
