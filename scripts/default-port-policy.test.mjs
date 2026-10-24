// Pure policy tests; none bind or request the user's live 7306 service.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {manifestForBuild} from '../packages/vscode/build-config.mjs';

for (const environment of ['test','production']) {
 test(`${environment} VSIX manifest uses the product default 7306`,()=>{
  const source={contributes:{configuration:{properties:{'blackhole.port':{type:'number',default:17306}}}}};
  const manifest=manifestForBuild(source,{environment});
  assert.equal(manifest.contributes.configuration.properties['blackhole.port'].default,7306);
  assert.equal(source.contributes.configuration.properties['blackhole.port'].default,17306);
 });
}
test('native, extension and daemon defaults do not fork the local port by channel',()=>{
 const read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
 assert.match(read('packages/desktop-launcher/cmd/blackhole/managed_port.go'),/defaultManagedPort\s*=\s*7306/);
 const native=read('packages/desktop-launcher/cmd/blackhole/managed.go');
 assert.doesNotMatch(native,/port\s*=\s*17306|Environment\s*==\s*"test"\s*&&\s*port\s*==\s*7306/);
 assert.match(read('packages/vscode/src/config.ts'),/port: managedPortValue\(\) \?\? c.get<number>\('port'\) \?\? 7306/);
 assert.match(read('src/config.ts'),/DEFAULT_PORT = 7306/);
});
test('desktop shortcut is simply BlackHole while stable installation identity is retained',()=>{
 const source=fs.readFileSync(new URL('../installers/windows/desktop.iss',import.meta.url),'utf8');
 const shortcut=source.split('\n').find(line=>line.startsWith('Name: "{autodesktop}'));
 assert.ok(shortcut);
 assert.ok(shortcut.startsWith('Name: "{autodesktop}\\BlackHole";'));
 assert.doesNotMatch(shortcut,/Desktop|Test|ProductName/);
 assert.match(source,/AppId=\{#ProductId\}/);
 assert.match(source,/UsePreviousAppDir=yes/);
 assert.match(source,/UsePreviousTasks=yes/);
});
