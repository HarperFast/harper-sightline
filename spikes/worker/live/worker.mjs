import { store } from './common.mjs';
import { processInbox } from '../src/processInbox.ts';

const by = process.env.WORKER ?? 'w1';
const crashAfter = process.env.CRASH_AFTER ? Number(process.env.CRASH_AFTER) : 0;

const s = store();
if (crashAfter) {
	const orig = s.claimResult.bind(s);
	let claims = 0;
	s.claimResult = async (id, who) => {
		const won = await orig(id, who);
		if (won) {
			claims += 1;
			if (claims >= crashAfter) {
				console.log(`[${by}] crashing after ${claims} claims`);
				process.exit(1);
			}
		}
		return won;
	};
}

const r = await processInbox(by, s);
console.log(`[${by}] processed=${r.processed.length} skipped=${r.skipped.length}`);
