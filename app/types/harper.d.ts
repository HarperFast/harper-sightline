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
}
