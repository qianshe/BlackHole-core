// Migrated from cloud-api/public-home: extension metadata belongs to Core.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('extension changelog stays a short note for its current package version',()=>{
 const changelog=fs.readFileSync(new URL('../CHANGELOG.md',import.meta.url),'utf8');
 const manifest=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8'));
 const versions=[...changelog.matchAll(/^## (\d+\.\d+\.\d+)\b/gm)].map(match=>match[1]);
 assert.deepEqual(versions,[manifest.version]);
 assert.doesNotMatch(changelog,/^## Unreleased\b/m);
 assert.ok(Buffer.byteLength(changelog)<4096);
 assert.ok((changelog.match(/^- /gm)?.length??0)<=5);
});
