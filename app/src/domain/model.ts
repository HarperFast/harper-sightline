// TypeScript mirror of schema.graphql, for use by resources/workers. Required
// (non-null `!`) schema fields are non-optional here. Epoch-ms times are number.

import type { OrderLane } from './orders.ts';

export type ShopStatus = 'active' | 'reauthorization_required' | 'uninstalled';
export type DeliveryStatus = 'accepted' | 'processed' | 'dead_letter';
export type EventDomain = 'order' | 'fulfillment' | 'inventory' | 'refund';
export type EventSource = 'webhook' | 'reconciliation';
// The order's lane, derived by src/domain/orders.ts. An alias, never a second copy
// of the union, so the stored column and the derived lane cannot drift.
export type ProjectionState = OrderLane;
export type ExpectationState = 'pending' | 'resolved' | 'suppressed' | 'expired';
export type FindingStatus = 'pending' | 'unconfirmed' | 'resolved' | 'suppressed';

export interface Shop {
	shopId: string;
	status: ShopStatus;
	scopes?: string;
	installedAt?: number;
	uninstalledAt?: number;
	lastReconciledAt?: number;
	reconciliationState?: string;
	ianaTimezone?: string;
}

export interface ShopCredential {
	shopId: string;
	accessTokenEnc?: string;
	refreshTokenEnc?: string;
	keyVersion?: number;
	expiresAt?: number;
	refreshTokenExpiresAt?: number;
	version?: number;
	status?: 'active' | 'reauthorization_required';
}

export interface AppAuditEvent {
	id: string;
	shopId: string;
	action: string;
	at: number;
	detail?: string;
}

export type DigestCadence = 'daily' | 'weekly';
export type DigestStatus = 'pending' | 'sent' | 'skipped';

export interface DigestSubscription {
	shopId: string;
	email?: string;
	cadence?: DigestCadence;
	status?: 'active' | 'paused';
	createdAt?: number;
	updatedAt?: number;
	lastBuiltAt?: number;
}

// No `email`, `bodyText` or `bodyHtml`, deliberately (schema.graphql's DigestOutbox
// comment): a durable record of a period (subject + counts), not the message. The
// address lives on DigestSubscription only, so clearing it or uninstalling erases it.
export interface DigestOutbox {
	id: string; // `${shopId}:${periodStart}`
	shopId: string;
	cadence?: DigestCadence;
	periodStart: number;
	periodEnd?: number;
	subject?: string;
	// Current-state count of ORDERS awaiting fulfillment confirmation when built
	// (isAwaitingConfirmation, src/domain/orders.ts). Not period-scoped and not named
	// `unconfirmed`, which means a GapFinding status (FindingStatus above).
	ordersAwaiting?: number;
	// Scoped to [periodStart, periodEnd), unlike getSummary's `findings.failedAttempts`.
	// Counts ORDERS (one finding per order and ruleVersion).
	failedAttemptsInPeriod?: number;
	deliveryGaps?: number;
	// Recorder health at build time, current-state like ordersAwaiting.
	recorderHealthy?: boolean;
	status: DigestStatus;
	createdAt: number;
}

export interface WebhookDelivery {
	id: string; // `${shopId}:${webhookId}`
	shopId: string;
	topic?: string;
	webhookId?: string;
	receivedAt: number;
	status: DeliveryStatus;
	attempts?: number;
	hmacVerified?: boolean;
	payload?: string | null; // allowlisted JSON body (src/privacy/pii.ts), for the worker to normalize; null once handled
	pendingKey?: string; // computed by Harper while accepted (processor.ts pendingKey); never written
}

export interface OperationalEvent {
	eventId: string;
	shopId: string;
	domain: EventDomain;
	topic?: string;
	resourceId?: string;
	sku?: string;
	quantity?: number;
	fulfillableItemCount?: number; // order events: units still requiring fulfillment
	orderName?: string;
	totalPrice?: number;
	currency?: string;
	locationId?: string;
	hasTracking?: boolean;
	trackingCompany?: string;
	shipmentStatus?: string;
	state?: string;
	source: EventSource;
	occurredAt: number;
	receivedAt: number;
}

export interface OrderProjection {
	id: string; // `${shopId}:${orderId}`
	shopId: string;
	orderId: string;
	financialStatus?: string;
	fulfillmentStatus?: string;
	paidAt?: number;
	cancelledAt?: number;
	fullyRefundedAt?: number;
	fulfilledAt?: number;
	requiresFulfillment?: boolean;
	orderName?: string;
	orderTotal?: number;
	currency?: string;
	fulfillmentFailedAt?: number;
	hasTracking?: boolean;
	trackingCompany?: string;
	trackingAt?: number;
	fulfillableItemCount?: number;
	state?: ProjectionState;
	deadline?: number;
	lastEventAt?: number;
	firstEventAt?: number;
	eventCount?: number;
	lastSourceVersion?: number;
}

export interface Expectation {
	id: string; // `${detector}:${orderId}:${ruleVersion}`
	shopId: string;
	orderId: string;
	detector: string;
	ruleVersion?: number;
	state: ExpectationState;
	deadline?: number;
	createdAt?: number;
	resolvedAt?: number;
}

export interface GapFinding {
	id: string;
	shopId: string;
	orderId: string;
	detector?: string;
	ruleVersion?: number;
	status: FindingStatus;
	detectedAt?: number;
	resolvedAt?: number;
	evidenceEventIds?: string[];
}

export interface FlowAggregate {
	id: string; // `${shopId}:${bucket}:${lane}`
	shopId: string;
	bucket: number;
	lane: string;
	count?: number;
}

export interface WorkerCheckpoint {
	id: string; // `${worker}:${partition}`
	cursor?: string;
	leaseHolder?: string;
	leaseExpiresAt?: number;
	retryCount?: number;
	updatedAt?: number;
}

export interface EventSku {
	id: string; // `${eventId}:${sku}`
	shopId: string;
	eventId: string;
	sku: string;
	quantity?: number;
	domain: EventDomain;
	topic?: string;
	source: EventSource;
	resourceId?: string;
	occurredAt: number;
	receivedAt: number;
}

export interface InventoryItem {
	id: string; // `${shopId}:${inventoryItemId}`
	shopId: string;
	inventoryItemId: string;
	sku?: string;
	productTitle?: string;
	variantTitle?: string;
	updatedAt?: number;
}

export interface ShopLocation {
	id: string; // `${shopId}:${locationId}`
	shopId: string;
	locationId: string;
	name?: string;
	updatedAt?: number;
}

export interface RedactionTombstone {
	id: string; // `${shopId}:${orderId}`, or `${shopId}:*` for a whole shop
	shopId: string;
	orderId?: string;
	redactedAt: number;
}
