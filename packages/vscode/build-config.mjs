// Explicit public build profiles. Never read dotenv or shell variables to select an environment.
import {readProfiles,clientTarget,validateOrigin,validatePublicKey,assertServiceBuild,PRODUCTION_ORIGIN,PRODUCTION_KEY} from '../../scripts/environment-config.mjs';
export const PRODUCTION_CLOUD_ORIGIN=PRODUCTION_ORIGIN;
export function resolveBuildConfig(environment='production',origin,publicKey,profiles){
 if(!['production','test'].includes(environment))throw new Error('Unknown build environment; use production or test.');
 if(environment==='production'&&(origin!==undefined||publicKey!==undefined))throw new Error('Cloud overrides are test-only; production always uses the fixed service.');
 // A complete explicit pair wins over local test configuration. Production never reads test.json.
 const explicitPair=environment==='test'&&origin!==undefined&&publicKey!==undefined;
 const target=explicitPair?{origin:validateOrigin(origin),entitlementPublicKey:validatePublicKey(publicKey)}
  :clientTarget(environment,profiles??readProfiles({loadTest:environment==='test'}));
 const endpoint=origin===undefined?target.origin:validateOrigin(origin);
 let key=publicKey;
 if(key===undefined){if(endpoint===target.origin)key=target.entitlementPublicKey;else if(endpoint===PRODUCTION_ORIGIN)key=PRODUCTION_KEY;else throw new Error('A custom test origin requires --cloud-public-key; changing only the URL cannot configure daemon trust.');}
 validatePublicKey(key);
 if((endpoint===PRODUCTION_ORIGIN)!==(key===PRODUCTION_KEY))throw new Error('Production and independent test signing trust must not be mixed.');
 if(environment==='test'&&(endpoint===PRODUCTION_ORIGIN||key===PRODUCTION_KEY))throw new Error('Test builds must not select production origin or signing trust.');
 return Object.freeze({environment,origin:endpoint,entitlementPublicKey:key});
}
export function parseBuildArgs(args,{packaging=false,requireEnvironment=false,profiles}={}){
 const values=new Map(),allowed=new Set(['--environment','--cloud-origin','--cloud-public-key',...(packaging?['--out','--core-package','--core-url']:[])]);
 for(let i=0;i<args.length;i+=2){const key=args[i],value=args[i+1];if(!allowed.has(key)||values.has(key)||!value||value.startsWith('--'))throw new Error('Invalid or duplicate build argument: '+key);values.set(key,value);}
 if(requireEnvironment&&!values.has('--environment'))throw new Error('Packaging requires explicit --environment test or production.');
 const build=resolveBuildConfig(values.get('--environment'),values.get('--cloud-origin'),values.get('--cloud-public-key'),profiles);
 if(packaging)assertServiceBuild(build);
 // Every shipped interaction entry carries one verified offline Core seed by default.
  // Thin (download-on-first-use) stays an explicit distribution choice only.
  const corePackage=packaging?(values.get('--core-package')??'offline-code'):undefined;
 if(packaging&&!['thin','offline-code','legacy-test'].includes(corePackage))throw new Error('Invalid --core-package');
 if(corePackage==='legacy-test'&&build.environment!=='test')throw new Error('Legacy packaging is test-only');
 return {build,out:values.get('--out'),corePackage,coreUrl:values.get('--core-url')};
}
/** A full offline VSIX must not silently label an older Core as the new release.
 * Thin/legacy packaging has a separate explicit policy and is not affected. */
export function assertBundledCoreVersion(corePackage, extensionVersion, signedCoreVersion) {
 if (corePackage === 'offline-code' && (!signedCoreVersion || signedCoreVersion !== extensionVersion))
  throw new Error('vsix_bundled_core_version_mismatch');
}
// Production manifests must not advertise developer-only daemon overrides.
export function manifestForBuild(manifest,build){
 const result=structuredClone(manifest),properties=result.contributes.configuration.properties;
 if(properties['blackhole.port'])properties['blackhole.port'].default=7306;
 delete properties['blackhole.daemonEntry'];
 if(build.environment==='test')properties['blackhole.daemonEntry']={type:'string',default:'',description:'仅测试版开发调试：指向编译后的 dist/cli.js。修改后重启 daemon；留空使用内置服务。不会切换云端环境。'};
 return result;
}
export function buildDefines(build){return {__BLACKHOLE_BUILD__:JSON.stringify(build)};}
export function daemonBuildDefines(build){return {__BLACKHOLE_ENTITLEMENT_TRUST__:JSON.stringify({origin:build.origin,publicKey:build.entitlementPublicKey})};}
