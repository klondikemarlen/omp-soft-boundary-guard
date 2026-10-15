# OMP Soft Boundary Guard

Opt-in OMP extension that requires one-shot approval for recognized external GitHub writes and logs soft, best-guess warnings for other mutations outside the current built-in boundary.

## What it guards

- Local `write` and structured `edit` operations, including both endpoints of an `edit` move.
- Mutating Git commands that resolve to a local checkout, including `git push`.
- `gh issue` creation and updates, `gh pr` creation and updates, and mutating `gh api` requests.
- Supported `xd://github` issue and pull-request writes.
- Python `eval` calls containing direct `subprocess.run([...])` GitHub CLI invocations with literal argv.

When the active checkout and target resolve to different GitHub repositories, the installed extension blocks recognized GitHub writes before execution and requests the standard OMP Ask. The question shows the destination and command or Python code. Rejecting keeps that invocation blocked; approving permits one exact retry. Other recognized external mutations log a warning and proceed. Same-boundary mutations remain silent unless a reviewed policy produces an advisory warning.

Read-only operations, unknown or malformed operations, dynamic or ambiguous commands, unresolved paths, unresolved repositories, missing checkout information, unavailable UI, and guard errors fail open. This is approval protection for supported operations, not a hard execution sandbox. The underlying tool remains responsible for validating anything the guard cannot classify confidently.
Static GraphQL queries and every GraphQL mutation pass through without a warning when their target cannot be resolved.

The current built-in boundary is the invoking session's normalized GitHub `origin`, or its canonical Git root when no GitHub origin exists. Tool `cwd` starts execution; supported shell `cd` changes apply to subsequent command segments, and literal Git `-C` and `-c` options are preserved for target-side Git queries. None of these redefine the invoking boundary. The installed extension uses `createRepositoryBoundaryGuard({ enforce: "github" })`. Programmatic callers can use `{ enforce: true }` for all recognized external mutation categories, or `{ enforce: false }` (also the factory default) for warnings only. Advisory-only mode does not provide approval protection.

For recognized `xd://github` mutations that omit `repo`, the guard pins the tool's execution input to that normalized `origin`. This prevents another resolver from silently selecting a distinct configured remote such as `upstream`; explicit external repositories follow the installed approval path.

Python recognition parses syntax without executing the supplied code or requiring a Python interpreter. It supports direct `subprocess.run` calls with a literal list of plain, unescaped string arguments, optional `input` supplied as a variable, and boolean `check`, `capture_output`, and `text` keywords. Aliases, dynamic argv, unsupported subprocess options, malformed code, and multiple recognized writes remain unresolved and fail open. Calls hidden inside Python strings or comments are not treated as executable writes.

## Handoff inspection

`bun run handoff` reads `{"event":{"toolName":…,"input":…},"cwd":"…"}` from standard input and writes one JSON packet. Its `decision` is `allow` or `ask`; an `ask` packet includes the exact standard OMP Ask payload, active repository, resolved mutation target, action, and exact-retry fingerprint.

```bash
printf '%s\n' '{"event":{"toolName":"bash","input":{"command":"git push https://github.com/elsewhere/example.git HEAD"}}}' | bun run handoff
```

## Install

```bash
omp plugin install github:klondikemarlen/omp-soft-boundary-guard
```

After installing or reinstalling, start a new OMP process before retesting. Reloading extensions does not replace a module already loaded by the process.

Approvals are held only in process memory; a plugin reload clears them, and a new OMP process does not carry an earlier approval. The blocked handoff is cached in memory for the pending confirmation and one exact retry. Directories within the same canonical Git root share that approval scope; a different worktree or checkout does not. A changed execution input or resolved target never uses the cached artifact or approval; an approved exact release remains pending until that invocation starts, another confirmation replaces it, the checkout changes, it is rejected, the plugin reloads, or the process ends. No prompt artifact is written to disk or retained across runs.

Cache lookup and authorization use the same canonical invocation identity. Object-key ordering and top-level tool intent `i` are ignored, as is `eval`'s top-level display `title`. Execution values, code, array order, and nested fields named `i` or `title` remain bound to approval.

Exact approval binds the submitted tool input, including Python code, not the contents of mutable Python globals, environment variables, stdin sources, or external files. Review those payload sources before approving; their runtime values are not inspected or snapshotted by the guard.

Release, deploy, publish, and promote commands—including repository wrappers, package scripts, nested shell commands, and GitHub release writes—are soft-boundary checks. Release targets come from the recognized release segment's execution checkout unless an explicit target is supplied. A release targeting the current checkout's resolved `klondikemarlen/*` GitHub origin is inside the built-in boundary and remains silently allowed, including under an active reviewed policy. Other resolved targets log a concise soft warning and proceed. Release classification never exempts another recognized external mutation in the same compound command. Programmatic strict mode reports the full command and requests the exact Ask when UI is available; without UI, the underlying operation proceeds.

An optional reviewed soft-boundary policy can be activated with `OMP_SOFT_BOUNDARY_POLICY` containing JSON `{ "name": "...", "positive": "...", "negative": "..." }` and `OMP_SOFT_BOUNDARY_POLICY_REVIEWED` set to the compiled policy fingerprint. Inspect the compiled output before copying its `sourceFingerprint`; an edited source or mismatched fingerprint stays inactive. With an active policy, built-in deterministic adapters remain the safety floor and the optional `@smol` classifier is advisory. Low-risk uncertainty proceeds with in-memory evidence; high-risk or likely outside cases log a soft warning and proceed. Model, UI, parser, and guard failures follow the configured `allow-and-record` behavior.

Policy fingerprints use SHA-256 over the normalized full source. Upgrading from `2.1.0` or earlier intentionally invalidates legacy environment review tokens. Inspect and re-review the compiled policy, then set its newly reported `sourceFingerprint`; there is no legacy-token fallback.

From the plugin checkout or its installed package directory (for example `~/.omp/plugins/node_modules/omp-soft-boundary-guard`), compute the reviewed fingerprint after inspecting the compiled policy:

```bash
export OMP_SOFT_BOUNDARY_POLICY='{"name":"Customer repository work","positive":"active checkout, source, tests, docs","negative":"other checkouts, production targets, credentials, secrets"}'
export OMP_SOFT_BOUNDARY_POLICY_REVIEWED="$(bun -e 'const { compileBoundaryPolicy } = await import("./index.ts"); console.log(compileBoundaryPolicy(JSON.parse(process.env.OMP_SOFT_BOUNDARY_POLICY)).sourceFingerprint)')"
```

For development:

```bash
omp --extension .
```

The package root declares `index.ts` under `omp.extensions` for packaged installation.

## Development

```bash
bun test
```

## Release

Release policy:

- Patch versions cover merged behavior fixes, documentation, and maintenance changes.
- Minor versions cover new user-visible capabilities or supported policy changes.
- Major versions cover intentionally incompatible behavior changes.
- Every release must advance `package.json` beyond the latest semantic Git tag; `release:check` rejects an unchanged version.

```bash
bun run release:check
```

After `main` is pushed:

```bash
bun run reinstall
```

`bun run reinstall` is the normal release install path; it uses the generic GitHub reference and follows the repository's default branch. Use an exact commit hash with `--force` only when reproducing a specific release or diagnosing a stale cached install:

```bash
omp plugin install github:klondikemarlen/omp-soft-boundary-guard#<full-commit-hash> --force
```
