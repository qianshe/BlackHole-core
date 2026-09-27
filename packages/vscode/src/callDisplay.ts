import { isWorkspaceFileTool } from './toolNames';

export interface ToolCallDisplay { summary: string; details: string; }
type Obj = Record<string, unknown>;
function parseArgs(argsJson: string): Obj { try { const v: unknown=JSON.parse(argsJson); return v&&typeof v==='object'&&!Array.isArray(v)?v as Obj:{}; } catch{return{};} }
const str=(v:unknown):string=>typeof v==='string'?v:'';
const state=(v:unknown):string=>v==='completed'?'完成':v==='in_progress'?'进行中':v==='pending'?'待处理':str(v);
function itemLines(items:unknown):string[]{if(!Array.isArray(items))return[];return items.slice(0,20).flatMap(raw=>{if(!raw||typeof raw!=='object'||Array.isArray(raw))return[];const x=raw as Obj,c=str(x.content);return c?[`${c}${state(x.status)?` → ${state(x.status)}`:''}`]:[];});}
function primitive(v:unknown):string{if(typeof v==='string')return v.slice(0,80);if(typeof v==='number'||typeof v==='boolean'||v===null)return String(v);if(Array.isArray(v))return`(${v.length} 项)`;if(v&&typeof v==='object')return'(对象)';return'';}
/** Human-facing tool intent. Never falls back to serializing raw argument JSON. */
export function toolCallDisplay(tool:string,argsJson:string):ToolCallDisplay{const a=parseArgs(argsJson),cmd=str(a.command);
 if(['exec','pwsh','bash','cmd'].includes(tool)){const t=cmd||'执行命令';return{summary:t,details:t};}
 if(tool==='todo'){if(cmd==='read')return{summary:'读取任务清单',details:'读取任务清单'};const ls=itemLines(cmd==='patch'?a.updates:a.todos),goal=a.contract&&typeof a.contract==='object'&&!Array.isArray(a.contract)?str((a.contract as Obj).goal):'',action=cmd==='patch'?'更新任务':cmd==='write'?'写入任务清单':'任务清单',first=ls[0]??goal;return{summary:`${action}${first?` · ${first}`:''}`,details:[action,...(goal?[`目标：${goal}`]:[]),...ls].join('\n')};}
 if(tool==='process'){if(cmd==='start'){const script=str(a.script),name=str(a.name);return{summary:`启动${name?` ${name}`:''}${script?` · ${script}`:''}`,details:[name?`启动 ${name}`:'启动后台任务',script].filter(Boolean).join('\n')}}if(cmd==='list')return{summary:'列出后台任务',details:'列出后台任务'};const id=str(a.processId),close=a.closeTerminal===true;if(cmd==='stop')return{summary:`${close?'停止并关闭':'停止'} ${id}`.trim(),details:`${close?'停止并关闭':'停止'}后台任务${id?`\n${id}`:''}`};if(cmd==='status')return{summary:`查看 ${id}`.trim(),details:`查看后台任务状态${id?`\n${id}`:''}`};}
 if(isWorkspaceFileTool(tool)){const op=a.operation&&typeof a.operation==='object'&&!Array.isArray(a.operation)?a.operation as Obj:a,action=str(op.command),file=str(a.path),range=Array.isArray(op.view_range)&&op.view_range.length===2?` L${op.view_range[0]}-${op.view_range[1]===-1?'EOF':op.view_range[1]}`:'',t=`${action} ${file}${range}`.trim()||'文件操作';return{summary:t,details:t};}
 if(tool==='context_search'){const q=str(a.query),scope=str(a.path),t=`语义搜索${scope?` @${scope}`:''}${q?` · ${q}`:''}`;return{summary:t,details:t};}
 if(tool==='skill'){const name=str(a.name),p=str(a.path),t=name?`读取 ${name}${p?` · ${p}`:''}`:'列出技能';return{summary:t,details:t};}
 if(tool==='guide'){const workflow=str(a.workflow),target=str(a.tool),t=workflow==='handoff'?(a.action==='submit'?'提交 Handoff':'读取 Handoff 指导'):workflow?`加载 ${workflow} 工作流`:target?`查看 ${target} 使用说明`:'获取操作手册';return{summary:t,details:t};}
 if(tool==='show')return{summary:'打开实时进度面板',details:'打开实时进度面板'};
 if(tool==='proxy'){const target=str(a.tool)||'?';if(cmd==='list')return{summary:'列出可用工具',details:'列出可用工具'};if(cmd==='explain')return{summary:`查看 ${target}`,details:`查看 ${target}`};if(cmd==='cancel')return{summary:'取消代理调用',details:'取消代理调用'};if(cmd==='call'){let first='';const inner=str(a.argsJson);if(inner){const e=Object.entries(parseArgs(inner))[0];if(e)first=` · ${e[0]}=${primitive(e[1])}`;}const t=`调用 ${target}${first}`;return{summary:t,details:t};}}
 const t=cmd?`${tool} · ${cmd}`:tool;return{summary:t,details:t};}
