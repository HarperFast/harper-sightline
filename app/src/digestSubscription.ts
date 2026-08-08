import type { DigestCadence, DigestSubscription } from './model.ts';

// Validation and shaping for the notification subscription — the app's only
// merchant-supplied input, and the only merchant-identifying string it stores.
//
// Validation is strict and REJECTS rather than sanitizes. The stored address will
// eventually be handed to a mail transport, where a CR or LF is a header
// injection; quietly stripping characters would also mean storing an address the
// merchant did not type, which then silently fails to deliver.

// RFC 5321's practical maximum.
export const MAX_EMAIL_LENGTH = 254;

// Deliberately conservative: one @, no whitespace, no control characters, a dot
// in the domain. It rejects some exotic-but-legal addresses, which is the right
// trade for a notification field a merchant can retype.
const EMAIL_SHAPE = /^[^\s@,;:<>"'\\()[\]]+@[^\s@,;:<>"'\\()[\]]+\.[^\s@,;:<>"'\\()[\]]{2,}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function normalizeEmail(raw: unknown): string | undefined {
	if (typeof raw !== 'string') return undefined;
	if (CONTROL_CHARS.test(raw)) return undefined;
	const email = raw.trim().toLowerCase();
	if (email.length === 0 || email.length > MAX_EMAIL_LENGTH) return undefined;
	if (!EMAIL_SHAPE.test(email)) return undefined;
	return email;
}

export function normalizeCadence(raw: unknown): DigestCadence | undefined {
	return raw === 'daily' || raw === 'weekly' ? raw : undefined;
}

export interface SubscriptionView {
	email?: string;
	cadence: DigestCadence;
	status: 'active' | 'paused';
	lastBuiltAt?: number;
}

// What the API returns. An explicit projection, not the stored row: the row will
// grow, and a notification setting must never become a place other state leaks.
export function toSubscriptionView(row: DigestSubscription | undefined): SubscriptionView {
	return {
		...(row?.email ? { email: row.email } : {}),
		cadence: row?.cadence ?? 'daily',
		status: row?.status === 'active' ? 'active' : 'paused',
		...(row?.lastBuiltAt === undefined ? {} : { lastBuiltAt: row.lastBuiltAt }),
	};
}

function badRequest(message: string): Error & { statusCode: number } {
	const e = new Error(message) as Error & { statusCode: number };
	e.statusCode = 400;
	return e;
}

// Merge an update onto the existing row. `shopId` comes from the verified
// principal via the argument — a shopId in the BODY is ignored entirely, which is
// the tenant-isolation invariant for the app's first write endpoint.
export function applySubscriptionUpdate(
	existing: DigestSubscription | undefined,
	shopId: string,
	body: { email?: unknown; cadence?: unknown; status?: unknown },
	now: number,
): DigestSubscription {
	const next: DigestSubscription = {
		shopId,
		email: existing?.email,
		cadence: existing?.cadence ?? 'daily',
		status: existing?.status ?? 'paused',
		createdAt: existing?.createdAt ?? now,
		updatedAt: now,
		...(existing?.lastBuiltAt === undefined ? {} : { lastBuiltAt: existing.lastBuiltAt }),
	};

	if (body.email !== undefined) {
		// An explicitly empty string is "unsubscribe me", which is a legitimate and
		// important action; anything else that fails validation is an error the
		// merchant needs to see rather than a silent no-op.
		if (typeof body.email === 'string' && body.email.trim() === '') {
			next.email = undefined;
			next.status = 'paused';
		} else {
			const email = normalizeEmail(body.email);
			if (!email) throw badRequest('email is not a valid address');
			next.email = email;
			// Supplying an address is the act of subscribing.
			next.status = 'active';
		}
	}

	if (body.cadence !== undefined) {
		const cadence = normalizeCadence(body.cadence);
		if (!cadence) throw badRequest('cadence must be daily or weekly');
		next.cadence = cadence;
	}

	if (body.status !== undefined) {
		if (body.status !== 'active' && body.status !== 'paused') throw badRequest('status must be active or paused');
		if (body.status === 'active' && !next.email) throw badRequest('an address is required before activating');
		next.status = body.status;
	}

	return next;
}
