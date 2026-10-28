import {test} from 'node:test';
import assert from 'node:assert/strict';
import {waitForDesktopFeeds} from './verify-desktop-release-discovery.mjs';
const entries=[{manifest:{version:'0.4.32',platform:'windows',arch:'x64'},manifestJson:'signed-body',signature:'signed-signature'}];
test('waits through cache propagation, then accepts only the exact signed body and signature',async()=>{
 let refreshed=false,sleeps=0;
 const result=await waitForDesktopFeeds(entries,{attempts:2,sleep:async()=>{sleeps++;refreshed=true},fetcher:async url=>new Response(refreshed?(url.endsWith('.sig')?'signed-signature':'signed-body'):'old-cached-body')});
 assert.equal(result.discovered,true);assert.equal(result.attempt,2);assert.equal(sleeps,1);
});
test('a persistent stale feed or mismatch fails the publish verification',async()=>{
 await assert.rejects(()=>waitForDesktopFeeds(entries,{attempts:1,fetcher:async()=>new Response('old')}),/not_discovered/);
});
