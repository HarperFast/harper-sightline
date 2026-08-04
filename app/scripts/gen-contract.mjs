// Regenerate the checked-in API contract artifact from the single source of
// truth (src/apiContract.ts). Run `npm run contract:gen` after changing the
// contract; test/contract.test.ts fails in CI if the artifact drifts.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { API_CONTRACT } from '../src/apiContract.ts';

const out = fileURLToPath(new URL('../../contracts/sightline-api-v1.json', import.meta.url));
writeFileSync(out, JSON.stringify(API_CONTRACT, null, '\t') + '\n');
console.log(`wrote ${out}`);
