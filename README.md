# mend

[![make.fun bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/yuyun56/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/yuyun56/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`main.ts` is mend: one command-line tool that applies the edits AI models write, in four formats, to a tree of
files. Models write edits as a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, the V4A patch
format, and text-editor tool calls as JSON. mend reads all four to one written specification (SPEC.md, shipped in
the competition kit), finds the lines an edit names even when the model drifted their whitespace or indentation
(three matching tiers), and changes every file or none. It was built for the make.fun bounty
[Build mend, one patch tool for every AI edit format](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

Run it as:

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

## The files

- `main.ts`: the CLI, Node 22 and its standard library alone, run as `node main.ts [options] [PATCH]`. It
  implements the whole specification: the command line, the output and exit codes, safe paths, format detection,
  three-tier line matching, unified diffs, SEARCH/REPLACE blocks, V4A patches, JSON edits and the all-or-nothing
  write. Its last lines hand a trial over to `runner.ts` when `MAKEFUN_ENV_URL` is set: kept as the kit has them.
- `runner.ts`: the kit's runner, kept as it is. In a trial it reads the checks from the env, runs `node main.ts` on
  each one in a fresh directory, and posts what main.ts did (its exit code, its stdout and the files left in the
  directory).
- `LICENSE`: MIT.

## A check

A check is one run: its arguments, its standard input (or none) and the files it starts with. It passes when the
exit code, everything written to stdout and every file afterwards are exactly what the specification says. stderr
is never compared. Each run has 10 seconds.

The checks are written the way models get edits wrong: wrong line numbers, drifted whitespace and indentation,
blank context lines without their leading space, prose and code fences around the patch, CRLF files, files without
a final line break, blocks that occur twice. mend passed all 100 public practice checks.
