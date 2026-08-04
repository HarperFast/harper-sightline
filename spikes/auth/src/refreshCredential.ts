import type { OfflineToken } from './exchangeToken.ts';

export type CredentialStore = {
	read(): Promise<{ shopId: string; version: number; accessToken: string }>;
	conditionalWrite(
		expectedVersion: number,
		next: { accessToken: string; refreshToken: string; expiresAt: number; refreshTokenExpiresAt: number },
	): Promise<boolean>;
};

export async function refreshCredential(
	shopId: string,
	deps: { fetchNewToken: () => Promise<OfflineToken>; store: CredentialStore },
): Promise<{ rotated: boolean; version: number }> {
	const before = await deps.store.read();
	const tok = await deps.fetchNewToken();
	const wrote = await deps.store.conditionalWrite(before.version, {
		accessToken: tok.accessToken,
		refreshToken: tok.refreshToken,
		expiresAt: tok.obtainedAt + tok.expiresIn,
		refreshTokenExpiresAt: tok.obtainedAt + tok.refreshTokenExpiresIn,
	});
	if (!wrote) {
		const after = await deps.store.read(); // observe the winner's token
		return { rotated: false, version: after.version };
	}
	return { rotated: true, version: before.version + 1 };
}
