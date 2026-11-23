# makefun-site-faster

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/fyghdschb1275-wq/makefun-site-faster/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/fyghdschb1275-wq/makefun-site-faster/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A dependency-free, byte-for-byte compatible drop-in replacement for makefun-site 1.0.0, optimized for CPU time. On the kit's practice set its run() is about 2.5x faster than the reference (median 469 ms to 188 ms) with identical output, verified on all practice cases and 135 generated sites. Optimizations: slice-based HTML escaping instead of per-character escaping, counting loops instead of match arrays, hand-written lexer readers, offset-scan front matter parsing, and per-build memoization of slug, date and card computations.

## Run it

```sh
node main.ts
```

`main.ts` (Node 22.18+) reads every case from /input/cases.json, answers each with solve.js's run(input), and writes /output/answers.json.

---

<sub>Entered on [make.fun](https://make.fun/?ref=t764se0q&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
