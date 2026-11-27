# Changelog

## 2.1.16

- Approval tests answer the actual pending form and check displayed destinations, control safety and retry decisions directly. This release changes no guard policy.

## 2.1.15

- After a supported quoted issue-comment heredoc, the guard no longer infers a release directory through unsupported shell control flow. It still recognizes destinations that are explicit and do not depend on that directory.

## 2.1.14

- Push decisions include every resolved repository configured for the selected remote, in push order. Git config classification distinguishes operation flags from values and paths.

## 2.1.13

- Early external approval now records the invoking origin. Retrying a rejected release stays blocked without prompting again or spending an approval for a different release.

## 2.1.12

- Handoff CLI tests now exercise the supplied checkout and the process-directory fallback without requiring the developer's checkout to have a GitHub origin. Guard behavior is unchanged.

## 2.1.11

- Release checks compare the candidate with the highest stable version tag available locally, including tags outside the current branch. Nonrelease tags are ignored; a failed Git query stops the check.

## 2.1.10

- Pending confirmations and one-shot approvals follow the canonical checkout, not the identity of each operation. An observed change of checkout or known origin clears them, including when the intervening write was allowed.

## 2.1.9

- Compound release commands now resolve each segment's explicit repository or execution checkout independently. A known external destination still produces an advisory warning, or a confirmation for the full command in strict mode.

## 2.1.8

- A `gh issue comment` that reads a quoted heredoc with `--body-file -` no longer treats Markdown in its body as a repository. A subsequent read-back stays separate, and external comments still require approval for the exact submitted command.

## 2.1.7

- Local boundary tests now distinguish shared worktrees and same-origin checkouts from unrelated repositories outside the temporary-path exemption. Runtime policy is unchanged.

## 2.1.6

- Issue creation in a standalone, quoted Python heredoc can now request one-shot approval when the destination differs from the invoking checkout. The adapter recognizes direct `subprocess.check_output` with `text=True` and simple title or body variables; approval binds the submitted source, not mutable runtime data.
- When `gh issue create` omits `--repo`, the guard checks supported `GH_REPO` overrides and CLI remote defaults in the execution checkout. Read-only upstream inspection does not change the authorization boundary. A bare `GH_REPO=owner/repo` requires `GH_HOST=github.com` for deterministic resolution.
- Recognized issue creation with an unresolved repository, an unavailable approval UI, classifier failures, and guard exceptions produce fail-open diagnostics rather than implying approval.
