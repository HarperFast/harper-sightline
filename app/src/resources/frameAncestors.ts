import { isShopDomain } from '../auth/shopDomain.ts';

// Who may iframe the embedded app. Pure and separate from AppHome (like
// resolveAssetUrl) because the containment decision is the security control and a
// Resource class cannot be unit-tested without the Harper runtime.
//
// The shop from the verified session token wins. The query param is a pattern-checked
// fallback (Shopify sends `?shop=` on loads with no usable `id_token`), since an
// unvalidated `?shop=` could decide who frames the app or inject CSP directives.
// Anything unrecognized gets the myshopify wildcard rather than something narrower
// that would un-embed the app. The wildcard is weaker than one origin but still
// excludes every non-Shopify origin.
export function frameAncestors(verifiedShop: string | undefined, shopParam: string | undefined): string {
	const shop = (isShopDomain(verifiedShop) && verifiedShop) || (isShopDomain(shopParam) && shopParam) || undefined;
	return shop ? `https://${shop} https://admin.shopify.com` : 'https://*.myshopify.com https://admin.shopify.com';
}
