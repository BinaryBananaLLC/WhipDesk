# Copilot / AI-agent instructions for WhipDesk

**Read [AGENTS.md](../AGENTS.md) — it is the full operating contract.** This file only
restates the two non-negotiable rules so they're never missed:

- **Never touch git state.** Read-only git only. The user commits everything; leave edits
  uncommitted in the working tree.
- **Never update production.** No deploy/publish unless the user gives a one-off explicit
  instruction for that exact deploy.

# STRICT TOKEN & CONTEXT LIMITS
1. **Zero Chatter:** NO conversational filler, greetings, or acknowledgments (e.g., "Sure", "I can help", "Here is the code").
2. **Code Only:** Output ONLY the requested code, terminal commands, or exact file diffs. 
3. **No Explanations:** NEVER explain how the code works, why you wrote it, or your thought process unless explicitly asked. Summarize the work at the end.
4. **Context Frugality:** Read only the strictly necessary files. Do not summarize files or repeat existing code back to me unprompted. 
5. **Maximum Efficiency:** Output the absolute minimum number of tokens required to complete the immediate task.

Before editing, load `packages/protocol/src/index.ts` (the wire contract) and
`docs/ARCHITECTURE.md` (design seams). The code is the source of truth. Done =
`npm run typecheck` passes.
