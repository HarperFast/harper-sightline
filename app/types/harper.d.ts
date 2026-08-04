// Minimal ambient types for the Harper runtime surface this app uses.
// Not exhaustive — extended as the app grows.
declare module 'harper' {
	export interface RequestContext {
		headers: { get(name: string): string | null };
		response: { status: number };
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
