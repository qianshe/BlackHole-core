import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { mountMcp } from '../dist/mcp/router.js';
import { setAccessTokenOverride } from '../dist/util/token.js';
import { openDb } from '../dist/storage/db.js';
import { SessionsRepo } from '../dist/storage/sessions.js';
import { HandoffsRepo } from '../dist/storage/handoffs.js';
import { ToolCallsRepo } from '../dist/storage/toolCalls.js';
import { EventsRepo } from '../dist/storage/events.js';
import { TodosRepo } from '../dist/storage/todos.js';
import { SessionRuntime } from '../dist/runtime.js';

test('real HTTP guide saves with strict privacy, reconnects, and leaves consumption to work',async()=>{
 const storage=openDb(':memory:'),{db}=storage;
 const sessions=new SessionsRepo(db),handoffs=new HandoffsRepo(db);
 const row=sessions.create({workspace_path:process.cwd(),permission_mode:'read-only'});
 const sid='000000000000000000000000000000000000021';
 db.prepare('UPDATE sessions SET credential_id = ? WHERE id = ?').run(sid,row.id);
 const runtime=new SessionRuntime(sessions.get(row.id),{}),logs=[],clients=[];
 const app=express();app.use(express.json());const http=createServer(app);let cleaner;
 setAccessTokenOverride('handoff-http-synthetic');
 try {
  cleaner=mountMcp(app,{
   cfg:{},log:line=>logs.push(line),runtimes:new Map([[row.id,runtime]]),sessions,handoffs,
   toolCalls:new ToolCallsRepo(db),events:new EventsRepo(db,65536),todos:new TodosRepo(db),
   execution:{exec:{state:'cwd-only',shell:{syntax:'bash',executable:'bash',version:'fixture'},helpers:{rg:false,grep:false}},process:{available:false}},
  });
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
  const endpoint=new URL(`http://127.0.0.1:${http.address().port}/mcp/handoff-http-synthetic`);
  const connect=async()=>{const c=new Client({name:'bh-cli',version:'1'});clients.push(c);await c.connect(new StreamableHTTPClientTransport(endpoint));return c};
  const first=await connect();const tools=(await first.listTools()).tools;
  assert.ok(tools.find(t=>t.name==='guide').inputSchema.properties.content);assert.ok(!tools.some(t=>t.name==='handoff'));
  const content='HTTP_PRIVATE_MARKER_721\n中文上下文\ntask：';
  const call=(client,args)=>client.callTool({name:'guide',arguments:args});
  const saved=(await call(first,{sessionId:sid,workflow:'handoff',content})).structuredContent;
  assert.equal(saved.status,'saved');assert.equal(handoffs.get(row.id).content,content);
  for(const args of [{workflow:'handoff',content},{sessionId:sid,workflow:content},{sessionId:sid,workflow:'handoff',contnet:content},{sessionId:sid,workflow:'handoff',content:null},{sessionId:sid,workflow:'review',content}]){
   const result=await call(first,args);assert.equal(result.isError,true);assert.ok(!JSON.stringify(result).includes(content));assert.equal(handoffs.pendingId(row.id),saved.id);
  }
  sessions.setStatus(row.id,'paused');assert.equal((await call(first,{sessionId:sid,workflow:'handoff',content})).isError,true);sessions.setStatus(row.id,'active');
  db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(1,row.id);
  assert.equal((await call(first,{sessionId:sid,workflow:'handoff',content})).isError,true);
  db.prepare('UPDATE sessions SET expires_at = NULL WHERE id = ?').run(row.id);
  const audit=JSON.stringify([db.prepare('SELECT args_json,result_summary FROM tool_calls').all(),db.prepare('SELECT payload FROM session_events').all(),logs]);
  assert.ok(!audit.includes(content));assert.ok(!audit.includes(sid),'guide trace and audit never persist the credential');
  await first.close();const second=await connect();
  const read=await call(second,{sessionId:sid,workflow:'handoff'});assert.equal(read.structuredContent.status,undefined);assert.equal(handoffs.pendingId(row.id),saved.id);
  const result=await second.callTool({name:'editor',arguments:{sessionId:sid,path:'package.json',operation:{command:'view',view_range:[1,3]}}});
  assert.equal(result.isError,false);assert.equal(handoffs.get(row.id),null);
 }finally{
  for(const c of clients)await c.close().catch(()=>{});
  await cleaner?.closeAll();http.closeAllConnections();if(http.listening)await new Promise(resolve=>http.close(resolve));
  setAccessTokenOverride(undefined);storage.close();
 }
});

test('legacy SDK schema can strip content: a manual-only result is not a saved receipt',async()=>{
 const server=new McpServer({name:'legacy-guide',version:'1'});
 let received;
 server.registerTool('guide',{inputSchema:{sessionId:z.string().optional(),workflow:z.string().optional()}},async args=>{
  received=args;return{content:[{type:'text',text:JSON.stringify({manual:'legacy manual',instruction:'read only'})}],structuredContent:{manual:'legacy manual',instruction:'read only'}};
 });
 const client=new Client({name:'synthetic',version:'1'});const [ct,st]=InMemoryTransport.createLinkedPair();
 try{await server.connect(st);await client.connect(ct);
  assert.equal((await client.listTools()).tools[0].inputSchema.properties.content,undefined);
  const result=await client.callTool({name:'guide',arguments:{workflow:'handoff',content:'SYNTHETIC ONLY'}});
  assert.equal(received.content,undefined);assert.equal(result.structuredContent.status,undefined);
 }finally{await client.close();await server.close();}
});
