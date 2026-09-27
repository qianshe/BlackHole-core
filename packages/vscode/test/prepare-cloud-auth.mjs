import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const require=createRequire(path.join(root,'package.json')),ts=require('typescript');
const config=path.join(root,'packages/vscode/test/tsconfig.cloud-auth.json');
const raw=ts.readConfigFile(config,ts.sys.readFile);
if(raw.error)throw new Error('cloud_auth_test_configuration_invalid');
const parsed=ts.parseJsonConfigFileContent(raw.config,ts.sys,path.dirname(config));
const program=ts.createProgram(parsed.fileNames,parsed.options);
const diagnostics=[...parsed.errors,...ts.getPreEmitDiagnostics(program)];
if(diagnostics.length){console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCanonicalFileName:f=>f,getCurrentDirectory:()=>root,getNewLine:()=> '\n'}));process.exitCode=1;}
else {
 const directory=path.join(root,'.cache/vscode-auth-verify');mkdirSync(directory,{recursive:true});
 writeFileSync(path.join(directory,'package.json'),'{"type":"commonjs"}\n');
 if(program.emit().emitSkipped)throw new Error('cloud_auth_test_emit_failed');
 console.log('Cloud auth test modules compiled; no real extension host or credentials loaded.');
}
