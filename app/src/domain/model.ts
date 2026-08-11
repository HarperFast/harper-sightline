// TypeScript mirror of schema.graphql, for use by resources/workers. Required
// (non-null `!`) schema fields are non-optional here. Epoch-ms times are number.

import type { OrderLane } from './orders.ts';

export type ShopStatus = 'active' | 'reauthorization_required' | 'uninstalled';
export type DeliveryStatus = 'accepted' | 'processed' | 'dead_letter';
export type EventDomain = 'order' | 'fulfillment' | 'inventory' | 'refund';
export type EventSource = 'webhook' | 'reconciliation';
// The order's lane, derived from the latches by src/domain/orders.ts. An ALIAS, never a
// second copy of the union: the stored column and the derived lane are the same
// value set by construction (projection.ts writes deriveOrderLane's result into
// it), and two hand-maintained lists would let the two drift apart silently.
// NOTE: this replaces an earlier value set ('pending' | 'awaiting_window' |
// 'confirmed' | 'unconfirmed') that was declared but never written by any code
// path — no stored row has ever carried it, so redefining the column's meaning is
// safe.
export type ProjectionState = OrderLane;
export type ExpectationState = 'pending' | 'resolved' | 'suppressed' | 'expired';
export type FindingStatus = 'pending' | 'unconfirmed' | 'resolved' | 'suppressed';

// ─── sightline_core ───────────────────────────────────────────────────────────

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

// No `email`, `bodyText`, or `bodyHtml` field, deliberately — see schema.graphql's
// DigestOutbox comment. This is a durable RECORD of a period (subject + counts),
// not the message: the address lives on DigestSubscription only, so clearing it
// or uninstalling really does erase it, as the policy and the Notifications
// screen both promise, and the body is rendered fresh by a future sender
// (digestText/digestHtml in src/digest/digest.ts) rather than read back from a row that
// outlives the ledger for 30 days.
export interface DigestOutbox {
	id: string; // `${shopId}:${periodStart}`
	shopId: string;
	cadence?: DigestCadence;
	periodStart: number;
	periodEnd?: number;
	subject?: string;
	// Current-state, and a count of ORDERS: how many were awaiting fulfillment
	// confirmation when the digest was built (isAwaitingConfirmation, src/domain/orders.ts —
	// the Overview's awaiting tile, same population). Not period-scoped, and not a
	// findings tally: the name is deliberately not `unconfirmed`, which in this
	// codebase means a GapFinding STATUS (see FindingStatus above, and
	// getSummary's findings.unconfirmed) — a different population in a different
	// tense, and one order can produce two findings.
	ordersAwaiting?: number;
	// Scoped to this row's period, [periodStart, periodEnd) — the name says so because
	// getSummary's `findings.failedAttempts` counts the same findings with no time
	// bound at all. Also a count of ORDERS, not attempts: DETECTOR_FAILED writes one
	// finding per (order, ruleVersion), so two failed attempts on one order are one.
	failedAttemptsInPeriod?: number;
	deliveryGaps?: number;
	// Recorder health at build time, current-state like ordersAwaiting.
	recorderHealthy?: boolean;
	status: DigestStatus;
	createdAt: number;
}

// ─── sightline_ledger ─────────────────────────────────────────────────────────

export interface WebhookDelivery {
	id: string; // `${shopId}:${webhookId}`
	shopId: string;
	topic?: string;
	webhookId?: string;
	receivedAt: number;
	status: DeliveryStatus;
	attempts?: number;
	hmacVerified?: boolean;
	payload?: string; // PII-stripped JSON body, for the worker to normalize (#10)
}

export interface OperationalEvent {
	eventId: string;
	shopId: string;
	domain: EventDomain;
	topic?: string;
	resourceId?: string;
	sku?: string;
	quantity?: number;
	fulfillableItemCount?: number; // order events: units still requiring fulfillment (#12)
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
