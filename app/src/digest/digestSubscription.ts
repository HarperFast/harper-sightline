import type { DigestCadence, DigestSubscription } from '../domain/model.ts';

// Validation and shaping for the notification subscription, the app's only
// merchant-supplied input. It rejects rather than sanitizes: the address ends up in
// a mail transport where CR or LF is a header injection, and stripping would store
// an address the merchant did not type.

// RFC 5321's practical maximum.
export const MAX_EMAIL_LENGTH = 254;

// Conservative: one @, no whitespace or control characters, a dot in the domain.
// Rejecting some legal exotic addresses is fine for a field a merchant can retype.
const EMAIL_SHAPE = /^[^\s@,;:<>"'\\()[\]]+@[^\s@,;:<>"'\\()[\]]+\.[^\s@,;:<>"'\\()[\]]{2,}$/;
// C0, DEL and C1. C1 matters because U+009B is the single-byte ANSI escape
// introducer, which could carry a terminal escape into a raw-terminal render. The
// control characters are the point of the pattern, so the lint rule is disabled.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

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

// Explicit projection, not the stored row, so a notification setting cannot leak other state.
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

// `shopId` comes from the verified principal; a shopId in the body is ignored (tenant isolation).
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
		// An empty string means "unsubscribe"; any other validation failure is an error the merchant must see.
		if (typeof body.email === 'string' && body.email.trim() === '') {
			next.email = undefined;
			next.status = 'paused';
		} else {
			const email = normalizeEmail(body.email);
			if (!email) throw badRequest('email is not a valid address');
			next.email = email;
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
