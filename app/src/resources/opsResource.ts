import { Resource } from 'harper';
import { getOpsHealth } from '../../jobs.ts';
import { opsTokenAccepted } from '../auth/opsAuth.ts';
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
		if (!opsTokenAccepted(ctx.headers.get('x-sightline-ops-token'), process.env.SIGHTLINE_OPS_TOKEN)) {
			throw httpError('not found', 404);
		}
		return getOpsHealth();
	}
}
