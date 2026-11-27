# Changelog

## 2.1.8

- A `gh issue comment` that reads a quoted heredoc with `--body-file -` no longer treats Markdown in its body as a repository. A subsequent read-back stays separate, and external comments still require approval for the exact submitted command.

## 2.1.7

- Local boundary tests now distinguish shared worktrees and same-origin checkouts from unrelated repositories outside the temporary-path exemption. Runtime policy is unchanged.

## 2.1.6

- Issue creation in a standalone, quoted Python heredoc can now request one-shot approval when the destination differs from the invoking checkout. The adapter recognizes direct `subprocess.check_output` with `text=True` and simple title or body variables; approval binds the submitted source, not mutable runtime data.
- When `gh issue create` omits `--repo`, the guard checks supported `GH_REPO` overrides and CLI remote defaults in the execution checkout. Read-only upstream inspection does not change the authorization boundary. A bare `GH_REPO=owner/repo` requires `GH_HOST=github.com` for deterministic resolution.
- Recognized issue creation with an unresolved repository, an unavailable approval UI, classifier failures, and guard exceptions produce fail-open diagnostics rather than implying approval.
