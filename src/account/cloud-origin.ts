// Shared by the daemon (src/account) and the VS Code extension. Pure: no build-flavor or runtime settings.
import { createHash } from 'node:crypto';
import { productionProfile } from '../environments/production.cjs';

export const PRODUCTION_CLOUD_ORIGIN=productionProfile.origin;
export type CloudEnvironment='production'|'test';
export interface CloudEndpoint {environment:CloudEnvironment;origin:string;label:string}

export function validateCloudOrigin(value:string,{allowProduction=false}:{allowProduction?:boolean}={}):string {
 if(typeof value!=='string'||value!==value.trim()||value.length>512)throw new Error('cloud_origin_invalid');
 let url:URL;try{url=new URL(value);}catch{throw new Error('cloud_origin_invalid');}
 if(url.protocol!=='https:'||url.origin!==value||url.username||url.password||url.port||url.pathname!=='/'||url.search||url.hash
   ||!url.hostname.includes('.')||/^\d+(?:\.\d+){3}$/.test(url.hostname)||/(?:^|\.)(?:localhost|invalid|example|test)$/.test(url.hostname)
   ||(!allowProduction&&url.origin===PRODUCTION_CLOUD_ORIGIN))throw new Error('cloud_origin_invalid');
 return url.origin;
}
export function cloudAuthPrefix(origin:string){return 'blackhole.cloud-auth.v1.'+createHash('sha256').update(validateCloudOrigin(origin,{allowProduction:true})).digest('hex');}
