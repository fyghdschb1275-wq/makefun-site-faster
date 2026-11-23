// Entry driver: reads every case from /input/cases.json, answers each with run() from solve.js, and
// writes /output/answers.json. Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in
// for /input and /output.
//
// V8 tuning, set before solve.js is imported: a timed run is one cold execution in a fresh
// container. --no-opt keeps TurboFan off (its compile CPU, counted on every thread, never pays
// back in a single pass); --single-threaded keeps Maglev compilation on the main thread instead
// of paying background-thread overhead; --no-sparkplug skips the baseline tier Maglev supersedes.
//
// Output is written case by case (stringify one answer, write it, then the next): measured
// end-to-end this beats building one 7 MB answers string and writing it at once.

import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

setFlagsFromString('--no-opt --single-threaded --no-sparkplug');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
const fd = openSync(join(OUTPUT_DIR, 'answers.json'), 'w');
writeSync(fd, '[');
cases.forEach((c, i) => {
  if (i) writeSync(fd, ',');
  writeSync(fd, JSON.stringify(run(c.input)));
});
writeSync(fd, ']');
closeSync(fd);
