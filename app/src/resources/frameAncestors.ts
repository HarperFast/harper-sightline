import { isShopDomain } from '../auth/shopDomain.ts';

// Who is allowed to iframe the embedded app. Pure and separate from AppHome for
// the same reason resolveAssetUrl is (assetPath.ts): the containment decision is
// the security control, and a Resource class cannot be unit-tested — it needs the
// Harper runtime to import at all.
//
// Security review F6: the CSP was built from `?shop=`, unvalidated, and the query
// param took PRECEDENCE over the verified principal — so a crafted URL decided who
// could frame the app, and a value carrying CSP syntax could append directives of
// its own.
//
// The order here is the fix: the shop from the verified session token wins, the
// query param is a pattern-checked fallback (Shopify sends `?shop=` on loads that
// carry no usable `id_token`, so dropping it entirely would break the embed), and
// anything unrecognized falls back to the myshopify wildcard rather than to
// something narrower that would silently un-embed the app.
//
// The wildcard IS weaker than a single origin, and it is what an unauthenticated
// load gets: at that point nothing has told us which store this is. It still
// excludes every non-Shopify origin, which is what framing protection is for here.
export function frameAncestors(verifiedShop: string | undefined, shopParam: string | undefined): string {
	const shop = (isShopDomain(verifiedShop) && verifiedShop) || (isShopDomain(shopParam) && shopParam) || undefined;
	return shop ? `https://${shop} https://admin.shopify.com` : 'https://*.myshopify.com https://admin.shopify.com';
}
