import { Resource } from 'harper';
import { getOpsHealth } from '../../jobs.ts';
import { opsTokenAccepted } from '../auth/opsAuth.ts';
import { optionalSecret } from '../secrets/secretsPolicy.ts';
import { httpError } from './http.ts';

// Operator health, gated on a shared secret because the callers are the load harness
// and post-deploy checks, not a merchant. Answers from tables (getOpsHealth), so any
// node reports the cluster's backlog. The payload is cross-shop counts and ages, and
// the route 404s (not 401s) on a missing or wrong token so it does not advertise itself.
export class OpsResource extends Resource {
	static path = '/api/v1/ops';
	allowRead() {
		return true;
	}
	async get() {
		const ctx = this.getContext();
		// `optionalSecret`: an unconfigured token is legitimate; opsTokenAccepted fails
		// closed on `undefined` and the route 404s as for a wrong token (a thrown
		// MissingSecretError would be a 500 that confirms the endpoint exists). Read per
		// request so a rotation applies without a redeploy.
		if (!opsTokenAccepted(ctx.headers.get('x-sightline-ops-token'), optionalSecret('SIGHTLINE_OPS_TOKEN'))) {
			throw httpError('not found', 404);
		}
		return getOpsHealth();
	}
}
