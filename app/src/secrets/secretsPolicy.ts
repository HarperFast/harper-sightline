import { secrets } from '#harper';

// The single read path for secret material and the single place that decides what a
// missing one means: always an error. There is no dev fallback and no opt-in strict
// mode (a default-off fail-closed flag is fail-open).
//
// Read order: Harper's scoped `secrets` accessor, then `process.env`.
//   - `secrets.X` is provisioned with `set_secret` + `grants: ['sightline']`
//     (scripts/set-secrets.mjs), stored encrypted, replicated, and never enters
//     `process.env`. The accessor is live, so a rotation applies without a redeploy.
//     This is the production path.
//   - `process.env.X` is the fallback for local dev, `node --test`, CI, and an
//     unreachable secrets store. It comes second because config.yaml declares the
//     secrets required, so falling back to an env var is deliberate.
//
// Operational precondition: reading a scoped secret needs the cluster's custody
// keypair. Without custody Harper can replicate the envelope but not decrypt it, and
// config.yaml's `env:` declaration fails with `custody-unavailable`. Verify with the
// `get_secrets_public_key` operation before relying on the store.

export class MissingSecretError extends Error {
	readonly statusCode = 500;
	constructor(name: string, detail?: string) {
		super(
			`${name} is not configured${detail ? ` (${detail})` : ''}. ` +
				`Provision it as a scoped Harper secret (set_secret with grants: ['sightline'], see scripts/set-secrets.mjs) ` +
				`or set ${name} in the environment. If the secret exists but does not resolve, the reason is one of: ` +
				`'missing' (no row and no env var), 'ungranted' (row exists, this component is not in its grants), ` +
				`or 'custody-unavailable' (row exists but this node holds no custody key to decrypt it).`,
		);
		this.name = 'MissingSecretError';
	}
}

// Raw lookup for callers with a legitimate "not configured" state. Trims, because
// a pasted value often carries a trailing newline that fails like a wrong secret.
export function optionalSecret(name: string): string | undefined {
	const fromStore = secrets[name];
	if (typeof fromStore === 'string' && fromStore.trim()) return fromStore.trim();
	const fromEnv = process.env[name];
	if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();
	return undefined;
}

// For material the app cannot run without; throws rather than returning a default.
export function requiredSecret(name: string): string {
	const value = optionalSecret(name);
	if (value === undefined) throw new MissingSecretError(name);
	return value;
}
