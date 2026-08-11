import { Resource } from 'harper';
import { privacyPolicyHtml } from '../privacyPolicy.ts';
import { supportContact } from '../support.ts';

// The public privacy policy (#26). Deliberately UNAUTHENTICATED: the App Store
// listing links to it and a reviewer must be able to read it without installing
// the app. Contains no shop data — it is the same static document for everyone —
// so there is nothing here to scope to a tenant. No frame-ancestors CSP: unlike
// the app itself this is meant to open in a normal browser tab, not an iframe.
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
