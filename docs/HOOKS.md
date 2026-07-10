# Precision monitoring with agent-native hooks (optional)

WhipDesk's session monitor is **zero-config by default**: it observes agent processes and their
transcripts, so you never change how you launch Claude Code, Codex, Aider, etc. That inference is
deliberately debounced (a working agent often goes quiet for a few seconds mid-turn), so the
"agent stopped working" alert arrives up to ~30 seconds after the fact.

If you want the alert **the instant** an agent finishes or asks for input, agents that support
native hooks can tell WhipDesk directly. The hook POSTs to the local agent:

```
POST http://localhost:8787/api/agent-event
Authorization: Bearer <pairing token>
Content-Type: application/json

{ "agent": "claude", "event": "stopped", "cwd": "/path/to/project" }
```

- `agent` — one of `claude`, `codex`, `gemini`, `aider`, `copilot`, `opencode`, `cursor`, `amp`.
- `event` — `stopped` (turn ended / waiting on you) or `working` (a new turn started).
- `cwd` — the project directory, so the event lands on the right session when several run at once.

The pairing token lives in the agent's state dir (`~/.whipdesk/token` for an installed agent,
`<repo>/.whipdesk/token` for a source checkout). All local write-endpoints require it so nothing
else on your network can spoof events.

A monitor (or "always alert" mode) must be active for the session — hooks refine monitoring,
they don't replace it.

## Claude Code

Add to `~/.claude/settings.json` (or a project's `.claude/settings.json`):

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -X POST http://localhost:8787/api/agent-event -H \"Authorization: Bearer $(cat ~/.whipdesk/token)\" -H 'Content-Type: application/json' -d \"{\\\"agent\\\":\\\"claude\\\",\\\"event\\\":\\\"stopped\\\",\\\"cwd\\\":\\\"$PWD\\\"}\" >/dev/null || true"
          }
        ]
      }
    ],
    "Notification": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -X POST http://localhost:8787/api/agent-event -H \"Authorization: Bearer $(cat ~/.whipdesk/token)\" -H 'Content-Type: application/json' -d \"{\\\"agent\\\":\\\"claude\\\",\\\"event\\\":\\\"stopped\\\",\\\"cwd\\\":\\\"$PWD\\\"}\" >/dev/null || true"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "curl -s -X POST http://localhost:8787/api/agent-event -H \"Authorization: Bearer $(cat ~/.whipdesk/token)\" -H 'Content-Type: application/json' -d \"{\\\"agent\\\":\\\"claude\\\",\\\"event\\\":\\\"working\\\",\\\"cwd\\\":\\\"$PWD\\\"}\" >/dev/null || true"
          }
        ]
      }
    ]
  }
}
```

- `Stop` fires when Claude finishes a turn; `Notification` fires when it's waiting for input or
  permission — both map to `stopped` ("waiting on you"), which is exactly WhipDesk's alert.
- `UserPromptSubmit` marks the session as working again the moment you answer.
- The trailing `|| true` keeps Claude Code running even if the WhipDesk agent is down.

Source-checkout users: replace `~/.whipdesk/token` with `<repo>/.whipdesk/token`.

## Generic notifications

For anything that isn't a monitored session (build scripts, cron jobs, other tools), use the
simpler `/api/notify` webhook — it pushes a notification to every connected phone:

```bash
curl -s -X POST http://localhost:8787/api/notify \
  -H "Authorization: Bearer $(cat ~/.whipdesk/token)" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Tests done","body":"312 passed","level":"success"}'
```

Or use the bundled helper, which reads the token for you: `npm run notify "Tests done"`.
