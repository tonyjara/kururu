---
name: update-models
description: Refresh the Claude and Codex model list that kururu's new-tab menu offers (LAUNCHERS in shared/launchers.ts). Use when the user says "update the models", "refresh the model list", "add the new Claude/Codex model", "a model is missing from the + menu", or runs /update-models.
---

# Updating the model list

The + on a tab strip offers a terminal and then an agent on a model. That list is
`LAUNCHERS` in `shared/launchers.ts`, written out by hand on purpose — see that
file's header for why it is not fetched at runtime. This skill is how it stays
current: find out what the two CLIs offer today, edit the file, and show the
diff.

**Never find out by running an agent.** `claude --model x -p hi` or `codex exec`
spends the user's tokens to learn one name — CLAUDE.md's second rule. Read caches,
help text and docs only. And never read a credential to call a models API
yourself: `server/src/usage.ts` is the only thing in kururu that touches one.

## Where the names come from

**Codex** keeps the list it was last served in `~/.codex/models_cache.json`.
Only rows with `visibility: "list"` are ones the Codex picker shows; order them by
`priority` (lower first). The cache is refreshed whenever Codex runs, so if its
`fetched_at` is old, say so rather than treating it as current.

```sh
python3 -c "
import json; d = json.load(open('$HOME/.codex/models_cache.json'))
print('fetched', d.get('fetched_at'))
for m in sorted(d['models'], key=lambda m: m.get('priority', 99)):
    if m.get('visibility') == 'list': print(m['slug'], '|', m.get('display_name'))
"
```

**Claude** has no cache. Use, in this order:

1. The model IDs in your own system prompt / environment section, and the
   `claude-api` skill if it is available — both list the current family.
2. `claude --help | grep -A6 -- --model` for which aliases the installed CLI knows.
3. Anthropic's models overview (WebFetch
   `https://docs.claude.com/en/docs/about-claude/models/overview`) to confirm a
   full ID and to find which models are deprecated or retired.

Use the **full model name** (`claude-opus-5-5`), never the alias (`opus`) — the
file's comment on `LAUNCHERS` explains why. The no-model `claude` row is what
follows the aliases.

## Editing `LAUNCHERS`

- **Ids are `cli:model`**, exactly — `launch.json` stores switched-off ids, so an
  existing row's id must never change. The test enforces the format.
- **Keep the two no-model rows** (`claude`, `codex`) at the head of their group.
- Newest first within a CLI. Labels read `Claude Opus 5.5`, `Codex GPT-5.6-Sol`.
- **Remove** a model only when its CLI no longer offers it (retired, or gone from
  the Codex cache's `list` rows). A merely older model stays unless the user asks.
- Model names must match `MODEL_NAME` — they are spliced into `sh -c`. If a real
  name does not, stop and tell the user rather than loosening the pattern.
- Adding a CLI other than Claude or Codex is a feature, not an update: it needs
  `AGENT_CLIS`, `CLI_LABELS` and `MODEL_FLAG`. Ask first.

## Finishing

```sh
bun test server/test/launchers.test.ts
bun run typecheck
```

Then add a line under `## [Unreleased]` in `CHANGELOG.md` naming the models
added and removed, show the user the diff of `shared/launchers.ts`, and stop.
Editing `shared/` restarts a running `bun run dev` server — a reconnect, no agents
lost — and the window picks the new list up on the next snapshot. **Do not commit.**
