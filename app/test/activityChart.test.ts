import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The activity chart is the one screen element whose correctness lives in CSS, and
// CSS is the one thing this suite never executes. That gap shipped a chart which
// computed every bar height correctly and then painted all 28 of them invisible:
//
//   .bar      { background: currentColor; opacity: 0.12; }   /* the track */
//   .bar-fill { background: currentColor; }                  /* the value */
//
// `opacity` composites an element AND its descendants as one group, so `.bar-fill`
// — same colour, nested inside — came out at the same 12% as the track it sits in.
// Uniform grey rectangles regardless of the data, while view.test.ts happily
// confirmed `height:0%` and `height:100%` were in the markup.
//
// So these parse the stylesheet and pin the two properties that made it invisible.
// A rendering test would be better and needs a browser; this catches the specific
// regression for the cost of a regex.

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');

function rule(selector: string): string {
	const found = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(html);
	assert.ok(found, `no CSS rule for ${selector}`);
	return found![1];
}

test('the bar track does not dim the value drawn inside it', () => {
	// The translucent track must be painted by the pseudo-element, whose opacity
	// applies only to itself — never by `.bar`, whose opacity would take `.bar-fill`
	// down with it.
	assert.doesNotMatch(
		rule('.bar'),
		/opacity/,
		'`opacity` on .bar composites .bar-fill into the track and makes every bar invisible — put it on .bar::before',
	);
	assert.match(rule('.bar::before'), /opacity:\s*0?\.\d+/, 'the track itself is the translucent layer');
	assert.match(rule('.bar::before'), /background:\s*currentColor/);
});

test('the bar value is painted at full strength, in the theme colour', () => {
	const fill = rule('.bar-fill');
	assert.match(fill, /background:\s*currentColor/, 'currentColor is what makes dark mode work without a second palette');
	assert.doesNotMatch(fill, /opacity/, 'a dimmed fill is the same defect one level down');
});

test('a bar of a few percent still sits above its own track', () => {
	// Without a stacking context the fill can be painted under the track's
	// pseudo-element, which reintroduces the invisible-bar symptom for short bars.
	assert.match(rule('.bar-fill'), /position:\s*relative/);
});
