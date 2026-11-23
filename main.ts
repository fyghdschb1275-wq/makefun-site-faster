// Entry driver: reads every case from /input/cases.json, answers each with run() from solve.js, and
// writes /output/answers.json. Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in
// for /input and /output.
//
// V8 tuning, set before solve.js is imported: a timed run is one cold execution in a fresh
// container. --no-opt keeps TurboFan off (its compile CPU, counted on every thread, never pays
// back in a single pass); --single-threaded keeps Maglev compilation on the main thread instead
// of paying background-thread overhead; --no-sparkplug skips the baseline tier Maglev supersedes.
//
// These flags were verified against the server's exact Node (v26.13.1, official binary, run
// locally): all three are accepted, the entry exits 0 and writes byte-identical answers to the
// v1 driver. That check was done because v3 — which first used this driver shape — failed the
// server's dev grading while passing grade-local 3/3; the flags and the streamed write below were
// the prime suspects and were exonerated (same answers, deterministic across runs, 160 MB peak
// vs the 1024 MB limit, 0.43–0.68 s wall vs the 10 s budget, even pinned to 1 CPU and with the
// heap capped at 768 MB). The try/catch below is belt-and-braces only: if a Node ever rejects a
// flag here, the entry still runs under default flags instead of dying before its first case.
//
// Output is written case by case (stringify one answer, write it, then the next): measured
// end-to-end this beats building one 7 MB answers string and writing it at once.

import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

try {
  setFlagsFromString('--no-opt --single-threaded --no-sparkplug');
} catch {
  // A rejected flag must never kill the entry; run under default flags instead.
}

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
