# AGENTS.md

Shared instructions for AI coding agents working in this repository.

`CLAUDE.md` is the detailed repository guide. Follow it for project structure, commands, style, the bug-fix protocol, and design decisions.

## Working Model

- Treat issues, specs, and failing tests as the source of truth.
- Keep changes small and reviewable. Prefer the existing module boundaries and helper APIs.
- For bugs, write the failing test first, verify it fails for the right reason, then make the smallest fix that turns it green.
- Do not rewrite existing test assertions unless the commit body explains the contract change with `BEHAVIOR-CHANGE:` or the non-behavioral rewrite with `ASSERTION-REFACTOR:`.
- Use automated review findings as review input. The maintainer owns final judgment, edits, and commits.
- Keep private dispatch state, credentials, local prompts, and per-developer overrides out of the repository.

## Required Checks

Run the narrow relevant tests while working and the broader suite before handoff:

```bash
npm test
npm --prefix mcp-server test
```

Use `npm run test:e2e` for browser-facing changes.
