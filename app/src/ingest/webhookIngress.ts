import { Deliveries } from '../db.ts';

// Namespaced idempotency key: one durable delivery per (shop, webhookId).
export function deliveryKey(shopDomain: string, webhookId: string): string {
	return `${shopDomain}:${webhookId}`;
}

// Durably accept a verified delivery, idempotently. The primary key guarantees
// one row per (shop, webhookId), so a duplicate delivery is a no-op. No
// normalization or Admin API calls happen here — the handler acks fast and a
// worker processes accepted rows later (ADR-002).
export async function acceptDelivery(args: {
	shopId: string;
	webhookId: string;
	topic: string;
	payload?: string;
}): Promise<'accepted' | 'duplicate'> {
	const id = deliveryKey(args.shopId, args.webhookId);
	const existing = await Deliveries.get(id);
	if (existing) return 'duplicate';
	await Deliveries.put({
		id,
		shopId: args.shopId,
		webhookId: args.webhookId,
		topic: args.topic,
		receivedAt: Date.now(),
		status: 'accepted',
		attempts: 0,
		hmacVerified: true,
		payload: args.payload,
	});
	return 'accepted';
}
