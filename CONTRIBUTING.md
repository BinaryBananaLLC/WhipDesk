# Contributing to WhipDesk

Thanks for helping out! Issues, PRs, and ideas are all welcome.

## Before you start

Read **[AGENTS.md](AGENTS.md)** — it's the operating contract for everyone touching this
codebase, humans and AI coding agents alike: where each kind of change belongs, the
wire-contract-first rule, dependency policy, and how to verify your work. This file is just the
quick start; AGENTS.md is the source of truth.

## Dev setup

```bash
npm install
npm run dev        # build the web controller + run the agent from source
npm run verify     # typecheck + tests across all workspaces — must pass before a PR
```

Node ≥ 20. macOS, Windows, and Linux are all first-class; CI runs the suite on all three.

## Pull requests

- Keep PRs focused — one change, with the reasoning in the description.
- `npm run verify` must pass; CI will run it on every platform anyway.
- Protocol changes start in `packages/protocol` (the wire contract), then flow into the agent
  and controller — never the other way around.
- New dependencies need a strong reason: N-API or pure-JS only, nothing that drags in a
  compiler toolchain (see AGENTS.md).

## Bugs & ideas

- Bugs → [GitHub issues](https://github.com/BinaryBananaLLC/WhipDesk/issues) (template provided).
- Security vulnerabilities → a [private security advisory](https://github.com/BinaryBananaLLC/WhipDesk/security/advisories/new),
  never a public issue. See [SECURITY.md](SECURITY.md).
- Ideas and questions → [r/WhipDesk](https://www.reddit.com/r/WhipDesk/) or a GitHub discussion/issue.

## License

WhipDesk is [AGPL-3.0](LICENSE); by contributing you agree your contribution is licensed the
same way.
