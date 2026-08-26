import { secrets } from '#harper';

// The single read path for every piece of secret material this app needs, and the
// single place that decides what happens when one is absent.
//
// WHAT CHANGED AND WHY. This module used to hold `requireRealSecrets()`, an
// opt-in strict mode gating two known-weak dev fallbacks: a Shopify app secret
// hardcoded in readSecret.ts (and therefore in git history), and a token
// encryption key derived from `sha256('sightline-dev-token-key')` in crypto.ts —
// a publicly derivable AES-256-GCM key wrapping Shopify offline tokens at rest.
// Both are gone. There is no fallback and no strict-mode flag to forget to set:
// a missing secret is always an error.
//
// That flag was the defect. It defaulted OFF "so nothing currently working
// breaks", which means the failure it existed to prevent — a production deploy
// silently running on a public key — was exactly the configuration you got by
// doing nothing. Fail-closed behind an opt-in is fail-open.
//
// READ ORDER. Harper's scoped secrets accessor first, `process.env` second.
//
//   - `secrets.X` is the scoped tier: provisioned with `set_secret` +
//     `grants: ['sightline']` (scripts/set-secrets.mjs), stored encrypted in
//     `system.hdb_secret`, replicated, and reachable ONLY through this accessor.
//     Scoped values never enter `process.env`, so they are absent from
//     environment dumps, `/proc/<pid>/environ`, and inherited child processes.
//     The accessor is live: a rotation is picked up on the next read, with no
//     redeploy. This is the production path.
//   - `process.env.X` stays as the fallback for local dev, `node --test`, and CI,
//     where there is no Harper instance to hold custody. It is also the escape
//     hatch if the secrets store is unreachable during an incident — which is
//     why the order is store-then-env and not the reverse: config.yaml declares
//     these as required, so an operator who has to fall back to an env var is
//     doing something deliberate.
//
// KNOWN OPERATIONAL PRECONDITION. Reading a scoped secret requires the cluster's
// custody keypair. On a node without custody, Harper can store and replicate the
// encrypted envelope but cannot decrypt it, and config.yaml's `env:` declaration
// fails with `custody-unavailable`. This instance's custody is currently
// uninitialised (`custody_fingerprint` null cluster-wide) and needs a Fabric-side
// re-init; until that lands, these secrets must come from `process.env` or the
// component will not serve. Verify custody with the `get_secrets_public_key`
// operation before relying on the store.

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

// The raw lookup, with no opinion about absence — for the few callers that have a
// legitimate "not configured" state. Trims, because a value pasted into
// `set_secret` or an env file routinely arrives with a trailing newline, and a
// secret that differs from the real one by one invisible byte fails in a way that
// looks nothing like a configuration error.
export function optionalSecret(name: string): string | undefined {
	const fromStore = secrets[name];
	if (typeof fromStore === 'string' && fromStore.trim()) return fromStore.trim();
	const fromEnv = process.env[name];
	if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();
	return undefined;
}

// The same lookup for material the app cannot correctly run without. Throws
// rather than returning a weak default — every caller of this used to have a
// fallback, and that is the whole point of the change.
export function requiredSecret(name: string): string {
	const value = optionalSecret(name);
	if (value === undefined) throw new MissingSecretError(name);
	return value;
}
