// Normalized identity derived from a verified request. The full principal +
// capability service lands in issue #5; this is the minimal shape resources
// authorize against so callers never depend on token format.
export type Principal = {
	shopId: string;
	userId: string;
	roles: string[];
	source: 'shopify-session';
};
