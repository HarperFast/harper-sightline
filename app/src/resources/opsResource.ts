import { Resource } from 'harper';
import { getOpsHealth } from '../../jobs.ts';
import { opsTokenAccepted } from '../auth/opsAuth.ts';
import { optionalSecret } from '../secrets/secretsPolicy.ts';
import { httpError } from './http.ts';

// Operator-facing health, gated on a shared secret rather than a merchant
// session — the callers are the load harness and the post-deploy checks, not a
// merchant in the admin. Answers from tables (see getOpsHealth), so on a
// multi-node cluster any node reports the whole cluster's backlog.
//
// Payload carries no merchant-identifying data by construction (opsHealth.ts is
// cross-shop counts and ages), and the route 404s — rather than 401s — when the
// token is missing or wrong, so an unconfigured environment does not advertise
// that the endpoint exists.
export class OpsResource extends Resource {
	static path = '/api/v1/ops';
	allowRead() {
		return true;
	}
	async get() {
		const ctx = this.getContext();
		// `optionalSecret`, not `requiredSecret`: an unconfigured ops token is a
		// legitimate state — opsTokenAccepted fails closed on `undefined`, and the
		// route then 404s exactly as it does for a wrong token, which is the
		// non-advertising behaviour this endpoint wants. Throwing MissingSecretError
		// here would turn "no ops token configured" into a 500 that confirms the
		// endpoint exists.
		//
		// Read per-request rather than captured at module load, so rotating the token
		// in the secrets store takes effect on the next call instead of the next
		// redeploy (the scoped accessor is live).
		if (!opsTokenAccepted(ctx.headers.get('x-sightline-ops-token'), optionalSecret('SIGHTLINE_OPS_TOKEN'))) {
			throw httpError('not found', 404);
		}
		return getOpsHealth();
	}
}
