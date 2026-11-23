# makefun-site-faster

Entry for make.fun bounty "Build a static site faster, 22 November 2026"
(site-generator-speed-01-run-20261122).

`solve.js` is a dependency-free, byte-for-byte compatible drop-in for
makefun-site 1.0.0, optimized for CPU time: slice-based HTML escaping
instead of per-character escaping, counting loops instead of match
arrays, hand-written lexer readers, and per-build memoization of
slug/date/card computations. `main.ts` is the harness driver: it reads
/input/cases.json and writes /output/answers.json.
