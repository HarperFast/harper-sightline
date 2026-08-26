// What a Shopify shop domain is allowed to look like. Its own module because two
// callers need the same answer for different reasons and neither should own it:
// AppHome interpolates a shop into the `frame-ancestors` CSP, and the session
// principal's `dest` host is checked against the same shape before it is trusted
// to appear in a response header.
//
// A shop domain is `<handle>.myshopify.com`, the handle being lowercase
// alphanumerics and hyphens starting with an alphanumeric. Anchored, with no dot
// allowed inside the handle, so a subdomain of an attacker's host
// (`evil.com.myshopify.com.attacker.example`) cannot pass, and the character class
// admits no space, semicolon, or quote — the primitives a CSP header injection
// would need (security review F6).
const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

// Shopify caps the store handle well below this; the length bound only exists so a
// megabyte of hyphens is rejected before the regex walks it.
const MAX_SHOP_DOMAIN_LENGTH = 255;

export function isShopDomain(value: unknown): value is string {
	return typeof value === 'string' && value.length <= MAX_SHOP_DOMAIN_LENGTH && SHOP_DOMAIN.test(value);
}
