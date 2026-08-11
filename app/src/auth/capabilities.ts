// Named capabilities, checked by resources/UI instead of plan-name strings.
// MVP grants only `record`; every recovery/write capability is denied. Future
// tiers flip these without changing call sites (dev plan §7 capability service).
export type Capability = 'record' | 'replay' | 'reannounce' | 'repair' | 'connectors' | 'multi_store' | 'long_retention';

export type Capabilities = Record<Capability, boolean>;

const RECORD_ONLY: Capabilities = {
	record: true,
	replay: false,
	reannounce: false,
	repair: false,
	connectors: false,
	multi_store: false,
	long_retention: false,
};

// MVP: every shop gets the same record-only profile. Later this reads the shop's
// entitlement (Shop.capabilityProfile) — the signature stays the same.
export function capabilitiesFor(_shopId: string): Capabilities {
	return { ...RECORD_ONLY };
}

export function hasCapability(caps: Capabilities, cap: Capability): boolean {
	return caps[cap] === true;
}

// 403 when a shop lacks a capability. AuthError is 401; use a distinct 403 here.
export function requireCapability(caps: Capabilities, cap: Capability): void {
	if (!hasCapability(caps, cap)) {
		const e = new Error(`capability not granted: ${cap}`) as Error & { statusCode: number };
		e.statusCode = 403;
		throw e;
	}
}
