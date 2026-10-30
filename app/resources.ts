// The component's resource entry point (config.yaml `jsResource`). This file is an
// EXPORT LAYER ONLY — one resource class per module under src/resources/, named
// after the class it exports. Harper registers every `Resource` subclass exported
// from here and routes it at its own `static path`, so the export order below is
// documentation, not routing.
//
// Keep it that way: no logic here. A bad import silently 404s *all* routes while
// the component still reports "healthy" (ADR-001), which is why the surface Harper
// loads stays this small and why scripts/smoke.mjs runs after every deploy.
//
// ./src/resources/boot.ts MUST be imported first: it installs the Harper log sink
// and the raw-body JSON content-type handler that webhook HMAC verification
// depends on.
import './src/resources/boot.ts';

export { PrivacyPolicy } from './src/resources/privacyPolicy.ts';
export { Health } from './src/resources/health.ts';
export { OpsResource } from './src/resources/opsResource.ts';
export { Session } from './src/resources/session.ts';

// Read API: every resource derives shopId from the verified principal (tenant
// isolation). Classes are *Resource-suffixed to avoid colliding with the table imports.
export { SummaryResource } from './src/resources/summaryResource.ts';
export { SetupResource } from './src/resources/setupResource.ts';
export { EventsResource } from './src/resources/eventsResource.ts';
export { FlowsResource } from './src/resources/flowsResource.ts';
export { OrdersResource } from './src/resources/ordersResource.ts';
export { ExportResource } from './src/resources/exportResource.ts';
export { FindingsResource } from './src/resources/findingsResource.ts';
export { PrivacyResource } from './src/resources/privacyResource.ts';
export { DigestResource } from './src/resources/digestResource.ts';

export { ComplianceWebhook } from './src/resources/complianceWebhook.ts';
export { ShopifyWebhook } from './src/resources/shopifyWebhook.ts';

export { AppHome } from './src/resources/appHome.ts';
