import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refreshCredential } from '../src/refreshCredential.ts';
import type { OfflineToken } from '../src/exchangeToken.ts';

function memStore(initial: { version: number; accessToken: string }) {
	let rec = { shopId: 's', version: initial.version, accessToken: initial.accessToken };
	return {
		async read() { return { ...rec }; },
		async conditionalWrite(expectedVersion: number, next: { accessToken: string }) {
			if (rec.version !== expectedVersion) return false; // lost race
			rec = { ...rec, version: rec.version + 1, accessToken: next.accessToken };
			return true;
		},
		current() { return rec; },
	};
}

const newTok = (t: string): OfflineToken => ({
	accessToken: t, scope: '', expiresIn: 100, refreshToken: 'rt', refreshTokenExpiresIn: 100, obtainedAt: 0,
});

test('concurrent refreshes converge to one valid token, version advances once', async () => {
	const store = memStore({ version: 1, accessToken: 'old' });
	const [a, b] = await Promise.all([
		refreshCredential('s', { fetchNewToken: async () => newTok('newA'), store }),
		refreshCredential('s', { fetchNewToken: async () => newTok('newB'), store }),
	]);
	const winners = [a, b].filter((r) => r.rotated).length;
	assert.equal(winners, 1, 'exactly one refresh writes');
	assert.equal(store.current().version, 2, 'version advanced exactly once');
	assert.match(store.current().accessToken, /^new(A|B)$/);
});
