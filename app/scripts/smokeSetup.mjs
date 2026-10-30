// Reads the install state out of a /api/v1/setup body. /setup has no `installed`
// field; the state is the step with key `installed` ('done' or 'pending').
// Returns undefined when the body is not a setup payload, so a caller cannot mistake
// an unreadable response for "uninstalled".
export function installedFromSetup(bodyText) {
	try {
		const step = JSON.parse(bodyText).steps?.find((s) => s?.key === 'installed');
		return step ? step.state === 'done' : undefined;
	} catch {
		return undefined;
	}
}
