// JSON is the single public production identity. This small CommonJS bridge works
// in the standalone NodeNext build and the existing CommonJS authentication tests.
// esbuild embeds the JSON in the VSIX; installed clients never read a developer dotenv.
import profile from './production.json';
export const productionProfile = Object.freeze(profile);
