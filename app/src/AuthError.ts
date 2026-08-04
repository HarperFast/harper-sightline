export class AuthError extends Error {
	statusCode: number;
	constructor(message: string, cause?: unknown) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = 'AuthError';
		this.statusCode = 401;
	}
}
