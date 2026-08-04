// TypeScript mirror of schema.graphql, for use by resources/workers. Required
// (non-null `!`) schema fields are non-optional here. Epoch-ms times are number.

export type ShopStatus = 'active' | 'reauthorization_required' | 'uninstalled';
export type DeliveryStatus = 'accepted' | 'processed' | 'dead_letter';
export type EventDomain = 'order' | 'fulfillment' | 'inventory' | 'refund';
export type EventSource = 'webhook' | 'reconciliation';
export type ProjectionState = 'pending' | 'awaiting_window' | 'confirmed' | 'unconfirmed';
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
}

export interface OperationalEvent {
	eventId: string;
	shopId: string;
	domain: EventDomain;
	topic?: string;
	resourceId?: string;
	sku?: string;
	quantity?: number;
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
