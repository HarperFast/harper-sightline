// Deliveries cleared per second between the first and last samples. `reason` matters:
// an unmeasurable rate because nothing was queued is a pass; one because the backlog
// never moved is the worst result and must not read as "kept up".
//
// /ops caps its backlog count (BACKLOG_COUNT_LIMIT) and sets `capped`; a capped count
// is a floor, so a delta from a capped sample under-reads the drain. Those samples
// are left out and counted in `cappedSamples`; if every sample is capped the rate is
// unmeasurable (`reason: 'capped'`).
export function drainProgress(samples, baselineAccepted) {
	const exact = samples.filter((s) => !s.capped);
	const cappedSamples = samples.length - exact.length;
	if (samples.length === 0) return { rate: null, reason: 'no-samples', cappedSamples };
	if (exact.length === 0) return { rate: null, reason: 'capped', cappedSamples };
	const first = exact[0];
	if (cappedSamples === 0 && first.accepted <= baselineAccepted) return { rate: null, reason: 'nothing-queued', cappedSamples };
	if (exact.length < 2) return { rate: null, reason: 'too-few-samples', cappedSamples };
	const last = exact[exact.length - 1];
	const cleared = first.accepted - last.accepted;
	const seconds = last.atSec - first.atSec;
	if (seconds <= 0) return { rate: null, reason: 'too-few-samples', cappedSamples };
	if (cleared <= 0) return { rate: 0, reason: 'no-progress', cappedSamples };
	return { rate: cleared / seconds, reason: 'measured', cappedSamples };
}
