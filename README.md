# dsh-plugin-swarm

[![npm version](https://img.shields.io/npm/v/@aaroncarry/dsh-plugin-swarm)](https://www.npmjs.com/package/@aaroncarry/dsh-plugin-swarm)
[![license](https://img.shields.io/github/license/aaroncarry/dsh-swarm)](./LICENSE)

**English** | [简体中文](./README.zh-CN.md)

Master/worker multi-agent orchestration for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

A high-intelligence **master agent** (the session agent) decomposes one goal into parallel subtasks and distributes them to **worker subagents** with different intelligence budgets. Workers run in their own fresh contexts through the `subagents` seam; an optional smart **reviewer** grades every result and re-runs weak ones once with feedback; an optional smart **synthesizer** merges everything into a single deliverable.

```
                        ┌─────────────────────────────┐
                        │  master agent (this session) │
                        │  swarm_run(goal, tasks…)     │
                        └──────────────┬──────────────┘
              ┌────────────────────────┼────────────────────────┐
              ▼                        ▼                        ▼
      ┌──────────────┐         ┌──────────────┐         ┌──────────────┐
      │ worker (fast)│  ...    │worker (std)  │  ...    │worker (smart)│   ≤16 tasks
      └──────┬───────┘         └──────┬───────┘         └──────┬───────┘
             └───────────┬────────────┴───────────┬────────────┘
                         ▼                        ▼
              ┌──────────────────┐      ┌──────────────────────┐
              │ reviewer (smart) │ ───► │ redo flagged tasks    │ (optional)
              └────────┬─────────┘      └──────────┬───────────┘
                       └───────────────┬───────────┘
                                       ▼
                         ┌──────────────────────────┐
                         │ synthesizer (smart)      │ (optional, on by default)
                         │ → one final deliverable  │
                         └──────────────────────────┘
```

## Features

- **Hierarchy by intelligence**: `fast` (small output budget), `standard` (inherits the master's model), `smart` (largest budget for the hardest steps, the reviewer, and the synthesizer).
- **Per-tier or per-task model overrides**: point cheap tiers at cheap models and keep `smart` on your best model.
- **Review-with-redo**: the reviewer returns a structured verdict plus per-task feedback; tasks flagged `redo` run once more with the reviewer's note appended.
- **Synthesis**: one coherent final deliverable that names which worker contributed what.
- **Leaf safety**: workers get the swarm tools denied via `toolFilter` (when the provider supports it) and are instructed not to start their own swarms.
- **Observability**: `swarm_status` lists active/recent runs; `swarm_providers` lists usable transports and LLM routes.

## Install

The plugin is a plain cordis plugin row, mounted through a dsh profile patch layer. Pick the package source that suits you:

```sh
# A. from npm (recommended; published as @aaroncarry/dsh-plugin-swarm)
dsh plugin --profile web add @aaroncarry/dsh-plugin-swarm

# B. straight from GitHub
dsh plugin --profile web add github:aaroncarry/dsh-swarm

# C. a local checkout (copies; re-run update after edits)
dsh plugin --profile web add file:../dsh-swarm

# 2. add the row to the profile's patch layer
#    $DSH_HOME/profiles/web/cordis.patch.yml  (see cordis.patch.example.yml)
```

The row (all config keys optional):

```yaml
- insert:
    - id: swarm
      name: '@aaroncarry/dsh-plugin-swarm'
      config:
        providerName: spawn
```

| Config key | Default | Meaning |
| --- | --- | --- |
| `providerName` | auto (`spawn` > `fork` > first) | Subagent transport provider for all swarm children |
| `maxTasks` | `16` | Hard cap on tasks per `swarm_run` call (1–32) |
| `historyLimit` | `20` | Completed runs remembered by `swarm_status` (0–100) |
| `defaultMaxConcurrency` | `4` | Parallel workers when a call omits `maxConcurrency` |
| `tierBudgets.fast` | `4096` | Max output tokens per request for fast workers |
| `tierBudgets.standard` | `0` | `0` = inherit the master agent's budget |
| `tierBudgets.smart` | `16384` | Max output tokens for smart workers / reviewer / synthesizer |

The profile patch layer is hot-applied by the dsh boot watcher; otherwise restart dsh.

## Tools

### `swarm_run`

Decompose ONE goal into up to 16 independent subtasks, run them with bounded concurrency, then optionally review and synthesize. Blocks until the whole swarm settles.

| Argument | Type | Meaning |
| --- | --- | --- |
| `goal` | string (required) | Overall objective |
| `tasks` | array (required) | `{ label, prompt, tier?, model?, provider? }` — prompts must be self-contained (workers see no conversation context) |
| `maxConcurrency` | integer (default 4) | Parallel workers, 1–16 |
| `modelOverrides` | object | `{ fast?, standard?, smart? }` model ids; `smart` also covers reviewer + synthesizer |
| `review` | boolean (default false) | Smart reviewer grades each result; flagged tasks rerun once with feedback |
| `synthesize` | boolean (default true) | Smart synthesizer merges results into one final deliverable |
| `providerName` | string | Override the row-configured transport for this call |

Returns `{ runId, goal, provider, tasks: [{ label, tier, status, output, error, redone }], review, finalAnswer }`.

### `swarm_providers`

Lists registered subagent providers (with capabilities) and LLM routes — use it to pick valid `model` / `provider` overrides.

### `swarm_status`

Lists currently active and recently completed swarm runs (`limit`, default 5, max 20).

## Requirements

- A dsh deployment whose host composition provides `subagents` (with at least one provider, e.g. `spawn`) and `tools`.
- The `llm` service is optional and only enriches `swarm_providers`.

## Development

No build step — the package ships its source. To iterate locally:

```sh
node --check src/index.js        # syntax check
dsh plugin --profile web add link:../dsh-plugin-swarm   # live-linked install (needs deps resolvable)
```

The runtime package has zero dependencies: everything is injected through cordis services. The `@deepseek-ai/dsh-*` entries in `peerDependencies` document the deployment contract; every real deployment already ships them.

## License

MIT — see [LICENSE](./LICENSE).
