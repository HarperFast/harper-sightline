// Named capabilities checked by resources and UI instead of plan-name strings. The
// MVP grants only `record`; future tiers flip these without changing call sites.
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

// MVP: every shop gets the record-only profile; later this reads the shop's entitlement.
export function capabilitiesFor(_shopId: string): Capabilities {
	return { ...RECORD_ONLY };
}

export function hasCapability(caps: Capabilities, cap: Capability): boolean {
	return caps[cap] === true;
}

export function requireCapability(caps: Capabilities, cap: Capability): void {
	if (!hasCapability(caps, cap)) {
		const e = new Error(`capability not granted: ${cap}`) as Error & { statusCode: number };
		e.statusCode = 403;
		throw e;
	}
}
