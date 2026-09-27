import { PRODUCTION_CLOUD_ORIGIN, validateCloudOrigin, type CloudEndpoint, type CloudEnvironment } from '../../../src/account/cloud-origin.js';
export { PRODUCTION_CLOUD_ORIGIN, validateCloudOrigin, cloudAuthPrefix, type CloudEndpoint, type CloudEnvironment } from '../../../src/account/cloud-origin.js';

// esbuild substitutes this literal. Runtime settings and process.env cannot switch it.
declare const __BLACKHOLE_BUILD__: { environment: CloudEnvironment; origin: string };
const compiledBuild = typeof __BLACKHOLE_BUILD__ === 'undefined'
 ? { environment: 'production' as const, origin: PRODUCTION_CLOUD_ORIGIN }
 : __BLACKHOLE_BUILD__;
if (compiledBuild.environment !== 'production' && compiledBuild.environment !== 'test') throw new Error('cloud_build_invalid');
if (compiledBuild.environment === 'production' && compiledBuild.origin !== PRODUCTION_CLOUD_ORIGIN) throw new Error('cloud_build_invalid');
const endpoint: Readonly<CloudEndpoint> = Object.freeze({
 environment: compiledBuild.environment,
 origin: validateCloudOrigin(compiledBuild.origin, { allowProduction: true }),
 label: compiledBuild.environment === 'test' ? '测试环境' : '正式环境',
});
/** Immutable build selection; old VS Code cloud settings are deliberately ignored. */
export function resolveCloudEndpoint(): Readonly<CloudEndpoint> { return endpoint; }
