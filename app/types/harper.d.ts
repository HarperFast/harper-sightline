// Minimal ambient types for the Harper runtime surface this app uses.
// Not exhaustive — extended as the app grows.
declare module 'harper' {
	export interface RequestContext {
		headers: { get(name: string): string | null };
		response: { status: number };
		body?: import('node:stream').Readable;
		data?: Promise<unknown>;
		url?: string;
	}
	export const contentTypes: Map<string, { serialize?: (data: unknown) => Buffer; deserialize?: (buffer: Buffer) => unknown; q?: number }>;
	export interface MiddlewareRequest {
		headers: { get(name: string): string | null; set(name: string, value: string): void; delete(name: string): void };
	}
	export class Resource {
		static path?: string;
		getContext(): RequestContext;
	}
	export const secrets: Record<string, string | undefined>;

	export interface TableQuery {
		conditions?: Array<{ attribute: string; value: unknown; comparator?: string }>;
		operator?: 'and' | 'or';
		sort?: { attribute: string; descending?: boolean };
		select?: string[];
		limit?: number;
		offset?: number;
	}
	export interface Table<T = Record<string, unknown>> {
		get(id: string): Promise<T | undefined>;
		put(record: T, txn?: unknown): Promise<void>;
		patch(id: string, partial: Partial<T>, txn?: unknown): Promise<void>;
		delete(id: string, txn?: unknown): Promise<void>;
		create(record: Partial<T>): Promise<T>;
		search(query: TableQuery): AsyncIterable<T>;
		getRecordCount(opts?: { exactCount?: boolean }): Promise<{ recordCount: number }>;
	}
	export const tables: Record<string, Table>;
	export const databases: Record<string, Record<string, Table>>;
	export function transaction<R>(callback: (txn: unknown) => Promise<R>): Promise<R>;
	export function getContext(): RequestContext;
}

// Harper injects `logger` as a global into component modules (not a `harper`
// export), alongside `server`. Method names are probed at runtime in
// src/harperLogSink.ts rather than relied on, so this type is intentionally loose.
declare const logger: Record<string, ((message: string) => void) | undefined> | undefined;

// Harper injects `server` as a global into component modules (not a `harper`
// export). Used to register HTTP middleware.
declare const server:
	| {
			http(
				listener: (
					request: { url?: string; headers: { get(n: string): string | null; set(n: string, v: string): void; delete(n: string): void } },
					next: (request: unknown) => unknown,
				) => unknown,
				options?: { before?: string; after?: string; urlPath?: string; port?: string | number },
			): void;
	  }
	| undefined;
