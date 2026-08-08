import { WINDOW_DAYS } from './apiContract.ts';
import { EXCLUDED_CUSTOMER_FIELDS } from './queries.ts';
import type { SupportContact } from './support.ts';

// The public privacy policy (#26). Served unauthenticated at /privacy-policy so
// the App Store listing can link to it and a reviewer can read it WITHOUT
// installing the app.
//
// Every factual claim here is traceable to something enforced in code, and the
// two that could drift are imported rather than retyped: the retention window
// (WINDOW_DAYS) and the excluded-field list (EXCLUDED_CUSTOMER_FIELDS, the same
// constant the in-app Privacy screen renders). See docs/data-inventory.md for the
// per-table behavior this summarises.
//
// LEGAL REVIEW REQUIRED before submission — see docs/app-store-review-checklist.md.
// This is an accurate engineering description of the app's data handling, which is
// the hard part, but it has not been reviewed as a legal instrument.

export const POLICY_ENTITY = 'HarperDB, Inc.';
export const POLICY_PRODUCT = 'Sightline by Harper';

function esc(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function contactBlock(support: SupportContact): string {
	const channels: string[] = [];
	if (support.email) channels.push(`<a href="mailto:${esc(support.email)}">${esc(support.email)}</a>`);
	if (support.url) channels.push(`<a href="${esc(support.url)}">${esc(support.url)}</a>`);
	if (!channels.length) {
		// Never fabricate a contact. An unconfigured deployment says so plainly.
		return `<p><strong>Support contact is not configured for this deployment.</strong> It must be set before public distribution.</p>`;
	}
	return `<p>Questions, data requests, or complaints: ${channels.join(' · ')}</p>`;
}

export function privacyPolicyHtml(support: SupportContact, updatedAt = 'Not yet published'): string {
	const excluded = EXCLUDED_CUSTOMER_FIELDS.map((f) => `<li>${esc(f)}</li>`).join('');
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Privacy Policy — ${esc(POLICY_PRODUCT)}</title>
<style>
	:root { color-scheme: light dark; }
	body { margin: 0 auto; padding: 2.5rem 1.25rem 4rem; max-width: 46rem;
		font: 16px/1.65 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
	h1 { font-size: 1.75rem; margin-bottom: .25rem; }
	h2 { font-size: 1.15rem; margin-top: 2.25rem; }
	.sub { opacity: .7; font-size: .9rem; margin-top: 0; }
	.lede { border-left: 3px solid currentColor; padding-left: 1rem; }
	code { font-size: .9em; }
	li { margin: .3rem 0; }
</style>
</head>
<body>
<h1>Privacy Policy</h1>
<p class="sub">${esc(POLICY_PRODUCT)}, operated by ${esc(POLICY_ENTITY)} · Last updated: ${esc(updatedAt)}</p>

<div class="lede">
<p><strong>${esc(POLICY_PRODUCT)} does not collect or store your customers' personal information.</strong>
It records operational facts about orders, fulfillments, inventory, and refunds — statuses, timestamps,
identifiers, SKUs and quantities — so a merchant can see where an expected operational confirmation is
missing. It never records who your customers are.</p>
</div>

<h2>What Sightline is</h2>
<p>Sightline is a read-only record of store activity. It subscribes to Shopify webhooks alongside your
other apps and keeps its own parallel log. It never sits between Shopify and your fulfillment,
inventory, or ERP systems, and it never writes to your store. If Sightline is unavailable, your
store's operation continues normally.</p>

<h2>What we store</h2>
<ul>
	<li>Order status and timestamps (paid, cancelled, closed), and order identifiers</li>
	<li>Order value and currency</li>
	<li>Fulfillment status, the location it shipped from, and whether tracking information is present</li>
	<li>Inventory levels by inventory item and location</li>
	<li>Refund status</li>
	<li>SKUs, product and variant titles, and quantities</li>
	<li>Your shop domain, the access scopes you granted, and install/uninstall timestamps</li>
	<li>Your store's configured timezone, so timestamps display in your local time</li>
	<li>An encrypted Shopify access token, used only to read the order data described above</li>
</ul>

<h2>What we never store</h2>
<p>Sightline excludes customer-identifying fields at the point of ingestion — they are stripped from
webhook payloads before anything is written, so they are never persisted at all:</p>
<ul>${excluded}</ul>
<p>We do not use cookies or tracking pixels, we run no advertising or analytics SDKs, we do not build
profiles, and we do not sell or rent data to anyone.</p>

<h2>How long we keep it</h2>
<p>Operational records — the event log, order state, and findings — are <strong>permanently deleted
after ${WINDOW_DAYS} days</strong> by a scheduled job that issues real deletes and then re-queries to
confirm nothing remains. This is deletion, not expiry or cache eviction.</p>
<p>Installation records (your shop domain, granted scopes, and the encrypted access token) are kept
while the app is installed.</p>

<h2>Deletion and your rights</h2>
<ul>
	<li><strong>Uninstall:</strong> your access token is revoked and your shop's data is erased.</li>
	<li><strong>Shop erasure:</strong> on Shopify's <code>shop/redact</code> request we delete every
		record belonging to your shop and verify that none remain.</li>
	<li><strong>Customer erasure:</strong> on Shopify's <code>customers/redact</code> request we delete
		the records linked to the identified orders. Because we hold no customer personal data, there is
		no customer profile to erase — only the operational records for those orders.</li>
	<li><strong>Data access requests:</strong> on Shopify's <code>customers/data_request</code> we
		record the request. As we store no personal data about your customers, there is no personal
		data to return.</li>
	<li><strong>Automatic:</strong> the ${WINDOW_DAYS}-day purge applies regardless of any request.</li>
</ul>

<h2>Security</h2>
<ul>
	<li>Shopify access tokens are stored only as AES-256-GCM encrypted envelopes. Plaintext tokens are
		never written to storage or logs.</li>
	<li>Every webhook is authenticated by verifying Shopify's HMAC signature over the raw request body
		before the payload is parsed. An unverified request is rejected and changes nothing.</li>
	<li>All traffic to Shopify and to the app is over HTTPS.</li>
	<li>Each shop's data is isolated: every query is constrained by the shop identity taken from
		Shopify's verified session token, never from anything a caller can supply.</li>
	<li>Application logs are filtered to remove tokens, signatures, and payload bodies.</li>
</ul>

<h2>Where data is processed</h2>
<p>Sightline runs on the Harper platform, operated by ${esc(POLICY_ENTITY)}, on infrastructure located
in the <strong>United States</strong>. Data is replicated between United States regions for
availability. We do not transfer your data to any other processor.</p>

<h2>Shopify's role</h2>
<p>Shopify is the source of the data described above and its own privacy terms govern your store.
Sightline receives data from Shopify only under the read scopes you granted at install
(<code>read_orders</code>, <code>read_fulfillments</code>, <code>read_inventory</code>) and requests
no write access of any kind.</p>

<h2>Changes to this policy</h2>
<p>Material changes will be reflected in the "last updated" date above, and the policy is versioned
alongside the application itself.</p>

<h2>Contact</h2>
${contactBlock(support)}
</body>
</html>`;
}
