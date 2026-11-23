// Entry driver: reads every case from /input/cases.json, answers each with run() from solve.js, and
// writes /output/answers.json. Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in
// for /input and /output.
//
// V8 tuning: --no-opt, set before solve.js is imported. A timed run is one cold execution in a fresh
// container, so TurboFan's optimizing compiler never pays for itself: it burns more CPU compiling
// (on background threads, all of it counted) than the optimized code saves. Maglev stays on. The
// house baseline's --no-incremental-marking measured worse than nothing here, so it is not set.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

setFlagsFromString('--no-opt');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
const answers: unknown[] = [];
for (const c of cases) answers.push(run(c.input));
writeFileSync(join(OUTPUT_DIR, 'answers.json'), JSON.stringify(answers));
