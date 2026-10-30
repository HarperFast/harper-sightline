// What a shop domain may look like, in one module because two callers need the same
// answer: AppHome interpolates a shop into the `frame-ancestors` CSP, and the session
// `dest` host is checked against it before appearing in a response header.
//
// `<handle>.myshopify.com`, the handle lowercase alphanumerics and hyphens starting
// with an alphanumeric. Anchored with no dot in the handle, so
// `evil.com.myshopify.com.attacker.example` fails, and the class admits no space,
// semicolon or quote (the primitives of CSP header injection).
const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

// Only bounds the regex walk so a megabyte of hyphens is rejected first.
const MAX_SHOP_DOMAIN_LENGTH = 255;

export function isShopDomain(value: unknown): value is string {
	return typeof value === 'string' && value.length <= MAX_SHOP_DOMAIN_LENGTH && SHOP_DOMAIN.test(value);
}
