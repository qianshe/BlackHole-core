import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {normalizeDebianPayloadModes} from './linux-package-modes.mjs';
test('public Debian directories, control metadata and executables survive private signing umask',{skip:process.platform==='win32'},t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bh-deb-modes-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const files=['DEBIAN/control','opt/BlackHole/blackhole','opt/BlackHole/bootstrap/node.exe','usr/bin/blackhole-desktop'];
 for(const name of files){const p=path.join(root,name);fs.mkdirSync(path.dirname(p),{recursive:true,mode:0o700});fs.writeFileSync(p,'fixture',{mode:0o600})}
 normalizeDebianPayloadModes(root);
 assert.equal(fs.statSync(path.join(root,'DEBIAN')).mode&0o777,0o755);
 assert.equal(fs.statSync(path.join(root,'DEBIAN/control')).mode&0o777,0o644);
 for(const name of files.slice(1))assert.equal(fs.statSync(path.join(root,name)).mode&0o777,0o755);
});
