import { tables, type Table } from 'harper';
import { encryptToken, decryptToken, type Envelope } from './crypto.ts';
import type { OfflineToken } from './exchangeToken.ts';
import type { ShopCredential } from './model.ts';

const Credentials = tables.ShopCredential as unknown as Table<ShopCredential>;

// Store the offline token as an encrypted envelope (ADR-001). version increments
// each rotation. Tokens/PII never returned or logged.
export async function saveCredential(shopId: string, tok: OfflineToken): Promise<void> {
	const prev = await Credentials.get(shopId);
	await Credentials.put({
		shopId,
		accessTokenEnc: JSON.stringify(encryptToken(tok.accessToken)),
		refreshTokenEnc: tok.refreshToken ? JSON.stringify(encryptToken(tok.refreshToken)) : undefined,
		keyVersion: 1,
		expiresAt: (tok.obtainedAt + tok.expiresIn) * 1000,
		refreshTokenExpiresAt: (tok.obtainedAt + tok.refreshTokenExpiresIn) * 1000,
		version: (prev?.version ?? 0) + 1,
		status: 'active',
	});
}

export async function loadAccessToken(shopId: string): Promise<string | null> {
	const row = await Credentials.get(shopId);
	if (!row?.accessTokenEnc) return null;
	return decryptToken(JSON.parse(row.accessTokenEnc) as Envelope);
}

export async function loadRefreshToken(shopId: string): Promise<string | null> {
	const row = await Credentials.get(shopId);
	if (!row?.refreshTokenEnc) return null;
	return decryptToken(JSON.parse(row.refreshTokenEnc) as Envelope);
}

export async function markCredentialStatus(shopId: string, status: 'active' | 'reauthorization_required'): Promise<void> {
	await Credentials.patch(shopId, { status });
}

export async function deleteCredential(shopId: string): Promise<void> {
	await Credentials.delete(shopId);
}
