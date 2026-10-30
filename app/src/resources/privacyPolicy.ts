import { Resource } from 'harper';
import { privacyPolicyHtml } from '../privacy/privacyPolicy.ts';
import { supportContact } from '../privacy/support.ts';

// The public privacy policy, unauthenticated so a reviewer can read it without
// installing. The same static document for everyone, so nothing is tenant-scoped.
// No frame-ancestors CSP: it opens in a normal tab, not an iframe.
export class PrivacyPolicy extends Resource {
	static path = '/privacy-policy';
	allowRead() {
		return true;
	}
	get() {
		return new Response(privacyPolicyHtml(supportContact(), process.env.SIGHTLINE_POLICY_UPDATED ?? 'Not yet published'), {
			status: 200,
			headers: { 'content-type': 'text/html; charset=utf-8' },
		});
	}
}
