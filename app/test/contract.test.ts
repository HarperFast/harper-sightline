import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { API_CONTRACT } from '../src/api/apiContract.ts';

// The checked-in artifact must match the source of truth. If this fails, run
// `npm run contract:gen` and commit the result — the API contract changed.
test('checked-in contract artifact matches src/api/apiContract.ts', () => {
	const artifact = JSON.parse(readFileSync(new URL('../../contracts/sightline-api-v1.json', import.meta.url), 'utf8'));
	assert.deepEqual(artifact, JSON.parse(JSON.stringify(API_CONTRACT)));
});
