// Wait only for verified metadata propagation; installer body verification remains
// in review-desktop-community-release.mjs and runs once after discovery is ready.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {collectFeedsFromDirectory,verifyCatalogFeedEntry} from './generate-cloud-desktop-catalog.mjs';
export async function waitForDesktopFeeds(entries,{fetcher=fetch,sleep=()=>delay(20000),attempts=31}={}){
 for(let attempt=1;attempt<=attempts;attempt++){
  try{
   for(const {manifest,manifestJson,signature} of entries){
    const route='https://blackhole.stellarbridge.dpdns.org/downloads/updates/stable/'+manifest.platform+'-'+manifest.arch+'/latest.json';
    for(const suffix of ['', '.sig']){
     const response=await fetcher(route+suffix,{signal:AbortSignal.timeout(15000)});
     assert.equal(response.status,200);const text=await response.text();
     assert.equal(suffix?text.trim():text,suffix?signature:manifestJson);
    }
   }
   return {discovered:true,version:entries[0].manifest.version,attempt};
  }catch{if(attempt===attempts)throw Error('desktop_release_not_discovered_before_deadline');}
  await sleep();
 }
}
async function main(){
 const {values}=parseArgs({options:{'feeds-dir':{type:'string'}}});assert.ok(values['feeds-dir']);
 const pins=JSON.parse(fs.readFileSync(new URL('../release/production-public-keys.json',import.meta.url)));
 const entries=collectFeedsFromDirectory(values['feeds-dir']).map(f=>verifyCatalogFeedEntry(f.manifestJson,f.signature,pins.updatePublicKey));
 assert.equal(entries.length,5);console.log(JSON.stringify(await waitForDesktopFeeds(entries)));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(e=>{console.error(e.message);process.exitCode=1});
