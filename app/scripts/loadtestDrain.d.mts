export interface DrainSample {
	atSec: number;
	accepted: number;
	capped?: boolean;
}
export function drainProgress(
	samples: DrainSample[],
	baselineAccepted: number,
): {
	rate: number | null;
	reason: 'no-samples' | 'capped' | 'nothing-queued' | 'too-few-samples' | 'no-progress' | 'measured';
	cappedSamples: number;
};
