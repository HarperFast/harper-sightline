import { Deliveries } from '../db.ts';

export function deliveryKey(shopDomain: string, webhookId: string): string {
	return `${shopDomain}:${webhookId}`;
}

// Durably accepts a verified delivery, idempotently: the primary key gives one row
// per (shop, webhookId). No normalization or Admin API calls here (ADR-002).
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
