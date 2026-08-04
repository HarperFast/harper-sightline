import { Resource } from 'harper';

export class Ping extends Resource {
	static async get() {
		return { ok: true, spike: 'auth', ts: Date.now() };
	}
}
