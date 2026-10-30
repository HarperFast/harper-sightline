import { Resource } from 'harper';
import { VERSION } from './auth.ts';

// Public health probe, and the post-deploy guard in scripts/smoke.mjs: a bad import
// silently 404s all routes while the component reports healthy (ADR-001).
export class Health extends Resource {
	static path = '/api/v1/health';
	allowRead() {
		return true;
	}
	get() {
		return { ok: true, service: 'sightline', version: VERSION };
	}
}
