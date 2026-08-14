/**
 * dsh-plugin-swarm — master/worker multi-agent orchestration for DeepSeek Harness.
 *
 * One master agent (the session agent that calls the tool) decomposes a goal
 * into parallel subtasks and fans them out to worker subagents through the
 * `subagents` seam, each worker with a per-tier budget. Optional stages:
 * a smart reviewer grades every result and re-runs flagged tasks once with
 * feedback, and a smart synthesizer merges everything into one deliverable.
 *
 * The package is dependency-free at runtime: everything it needs comes from
 * the injected cordis services (`subagents`, `tools`) and the `defineTool`
 * helper re-exported by `@deepseek-ai/dsh-tools` (a peer present in every
 * dsh deployment). Row config is read defensively in `apply`.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'dsh-plugin-swarm'
export const inject = ['subagents', 'tools']

const DEFAULT_TIER_BUDGETS = { fast: 4096, standard: 0, smart: 16384 }
const DEFAULT_MAX_TASKS = 16
const DEFAULT_HISTORY_LIMIT = 20
const DEFAULT_MAX_CONCURRENCY = 4
const SWARM_TOOL_NAMES = ['swarm_run', 'swarm_providers', 'swarm_status']

/** Strict object-rooted JSON schema for the reviewer's structured verdict. */
const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'feedback'],
  properties: {
    verdict: { type: 'string', description: 'One-sentence overall verdict.' },
    feedback: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'redo', 'note'],
        properties: {
          label: { type: 'string' },
          redo: { type: 'boolean' },
          note: { type: 'string' },
        },
      },
    },
  },
}

/**
 * Validate and default the row config. Cordis passes the row's `config`
 * object verbatim; this package declares no Config schema, so apply() is the
 * single normalization point and unknown keys are ignored.
 */
function normalizeConfig(config) {
  const cfg = config !== null && typeof config === 'object' ? config : {}
  const tiers = cfg.tierBudgets !== null && typeof cfg.tierBudgets === 'object' ? cfg.tierBudgets : {}
  const numberIn = (value, fallback, { min = -Infinity, max = Infinity } = {}) =>
    Number.isInteger(value) && value >= min && value <= max ? value : fallback
  return {
    providerName: typeof cfg.providerName === 'string' && cfg.providerName.length > 0 ? cfg.providerName : undefined,
    maxTasks: numberIn(cfg.maxTasks, DEFAULT_MAX_TASKS, { min: 1, max: 32 }),
    historyLimit: numberIn(cfg.historyLimit, DEFAULT_HISTORY_LIMIT, { min: 0, max: 100 }),
    defaultMaxConcurrency: numberIn(cfg.defaultMaxConcurrency, DEFAULT_MAX_CONCURRENCY, { min: 1, max: 16 }),
    tierBudgets: {
      fast: numberIn(tiers.fast, DEFAULT_TIER_BUDGETS.fast, { min: 1 }),
      standard: numberIn(tiers.standard, DEFAULT_TIER_BUDGETS.standard, { min: 0 }),
      smart: numberIn(tiers.smart, DEFAULT_TIER_BUDGETS.smart, { min: 1 }),
    },
  }
}

/** Concatenate the text blocks of a content-block array without trusting shapes. */
function textOf(blocks) {
  if (!Array.isArray(blocks)) return ''
  let out = ''
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') out += block.text
  }
  return out
}

/** Human-readable explanation of a terminal stop reason. */
function stopError(reason) {
  switch (reason) {
    case 'completed': return ''
    case 'aborted': return 'cancelled'
    case 'error': return 'worker failed'
    case 'max-tokens': return 'hit token limit before finishing'
    case 'refusal': return 'declined the task'
    default: return `ended abnormally (${String(reason)})`
  }
}

/** Best-effort JSON extraction from free text (fences tolerated). */
function parseJson(text) {
  if (typeof text !== 'string') return undefined
  let body = text.trim()
  body = body.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return undefined
  try {
    return JSON.parse(body.slice(start, end + 1))
  } catch {
    return undefined
  }
}

function workerPrompt(label, tier, taskPrompt, goal, extraNote) {
  const parts = [
    `[SWARM WORKER]\nYou are worker "${label}" (tier: ${tier}) in an agent swarm led by a master agent.`,
  ]
  if (typeof goal === 'string' && goal.length > 0) parts.push(`Overall swarm goal:\n${goal}`)
  parts.push(`Your assigned subtask:\n${taskPrompt}`)
  if (typeof extraNote === 'string' && extraNote.length > 0) parts.push(`Reviewer feedback on your previous attempt — fix exactly this:\n${extraNote}`)
  parts.push(
    'Rules:\n'
    + '- Work ONLY on your assigned subtask; do not try to solve the whole goal by yourself.\n'
    + '- You may use any tools you have (files, shell, web, other subagents), but you are a LEAF worker: '
    + 'never call swarm_run, swarm_providers, or swarm_status to start your own swarm.\n'
    + '- Finish with a complete, self-contained result for your subtask as your final message.',
  )
  return parts.join('\n\n')
}

/** Compact per-task section for reviewer/synthesizer inputs. */
function resultsText(tasks) {
  const parts = []
  for (const task of tasks) {
    const body = typeof task.output === 'string' && task.output.length > 0 ? task.output : `[empty output${task.error ? ` — ${task.error}` : ''}]`
    const brief = typeof task.prompt === 'string' && task.prompt.length > 0
      ? `Task: ${task.prompt.length > 500 ? `${task.prompt.slice(0, 500)}…` : task.prompt}\n`
      : ''
    parts.push(`### ${task.label} (tier: ${task.tier}${task.redone ? ', redone after review' : ''})\n${brief}Result:\n${body}`)
  }
  return parts.join('\n\n')
}

function reviewPrompt(goal, results) {
  return `[SWARM REVIEWER]\nYou are the review specialist (smart tier) of an agent swarm led by a master agent.\n`
    + `Overall goal:\n${goal}\n\n`
    + `Judge each worker result against BOTH the overall goal and that worker's own task (quoted in each section).\n\n`
    + `Worker results:\n${results}\n\n`
    + `Reply with ONLY a JSON object in exactly this shape:\n`
    + `{"verdict":"one-sentence overall verdict","feedback":[{"label":"worker label","redo":true,"note":"what to fix, or empty"}]}\n`
    + `Rules: one feedback entry per worker label; set redo=true only when a result is clearly wrong or incomplete `
    + `AND one focused retry could realistically fix it; otherwise redo=false. `
    + `If a structured-result tool is available to you, submit this JSON through it.`
}

function synthesisPrompt(goal, results, verdict) {
  const parts = [
    `[SWARM SYNTHESIZER]\nYou are the synthesis specialist (smart tier) of an agent swarm led by a master agent.\nOverall goal:\n${goal}`,
    `Worker results:\n${results}`,
  ]
  if (typeof verdict === 'string' && verdict.length > 0) parts.push(`Review verdict:\n${verdict}`)
  parts.push(
    'Merge everything into ONE coherent, complete final deliverable that fulfills the overall goal. '
    + 'Mention which worker contributed what where relevant. '
    + 'Return ONLY the final deliverable text — no JSON wrapper, no preamble.',
  )
  return parts.join('\n\n')
}

export function apply(ctx, config) {
  const cfg = normalizeConfig(config)
  let seq = 0
  const active = new Map()
  const history = []
  const liveRuns = new Set()
  const disposers = []

  /** Prefer an explicitly configured provider, else the best fresh-context one. */
  function pickProvider(explicit) {
    const names = ctx.subagents.list()
    if (typeof explicit === 'string' && explicit.length > 0) {
      return names.includes(explicit) ? explicit : undefined
    }
    if (names.length === 0) return undefined
    if (names.includes('spawn')) return 'spawn'
    if (names.includes('fork')) return 'fork'
    return names[0]
  }

  function smartOptions(modelOverrides) {
    const opts = { maxTokens: cfg.tierBudgets.smart }
    if (modelOverrides !== undefined && typeof modelOverrides.smart === 'string' && modelOverrides.smart.length > 0) opts.model = modelOverrides.smart
    return opts
  }

  /** Await one run's terminal result and always dispose; never throws. */
  async function settleRun(run) {
    const [execution] = await Promise.allSettled([run.result])
    const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
    liveRuns.delete(run)
    if (execution.status === 'rejected') {
      const reason = execution.reason
      return { status: 'failed', output: '', error: `infrastructure failure: ${String(reason && reason.message ? reason.message : reason)}` }
    }
    const result = execution.value
    const output = textOf(result.output)
    if (result.stopReason !== 'completed') {
      return { status: 'failed', output, error: stopError(result.stopReason) }
    }
    return { status: 'ok', output, error: '' }
  }

  /** Like settleRun but also surfaces the validated structured payload. */
  async function settleStructured(run) {
    const [execution] = await Promise.allSettled([run.result])
    const [disposal] = await Promise.allSettled([Promise.resolve().then(() => run.dispose())])
    liveRuns.delete(run)
    if (execution.status === 'rejected') {
      const reason = execution.reason
      return { ok: false, text: '', error: `infrastructure failure: ${String(reason && reason.message ? reason.message : reason)}`, structured: undefined }
    }
    const result = execution.value
    if (result.stopReason !== 'completed') {
      return { ok: false, text: textOf(result.output), error: stopError(result.stopReason), structured: undefined }
    }
    return { ok: true, text: textOf(result.output), error: '', structured: result.structured }
  }

  /** Start one child through the configured provider, tracking it for cleanup. */
  function startChild(providerName, provider, label, prompt, agentOptions, parent, signal, outputSchema) {
    const request = { label, prompt: [{ type: 'text', text: prompt }], parent, signal }
    if (agentOptions !== undefined) request.agentOptions = agentOptions
    if (outputSchema !== undefined) request.outputSchema = outputSchema
    if (provider.capabilities !== undefined && provider.capabilities !== null && provider.capabilities.toolFilter === true) {
      request.toolFilter = { deny: SWARM_TOOL_NAMES }
    }
    return ctx.subagents.start(providerName, request).then((run) => {
      liveRuns.add(run)
      return run
    })
  }

  async function launchWorker(providerName, provider, task, goal, modelOverrides, parent, signal, extraNote) {
    const tier = task.tier === 'fast' || task.tier === 'smart' ? task.tier : 'standard'
    const prompt = workerPrompt(String(task.label), tier, String(task.prompt), goal, extraNote)
    const opts = {}
    const budget = cfg.tierBudgets[tier]
    if (budget > 0) opts.maxTokens = budget
    if (modelOverrides !== undefined && typeof modelOverrides[tier] === 'string' && modelOverrides[tier].length > 0) opts.model = modelOverrides[tier]
    if (typeof task.model === 'string' && task.model.length > 0) opts.model = task.model
    if (typeof task.provider === 'string' && task.provider.length > 0) opts.provider = task.provider
    const agentOptions = Object.keys(opts).length === 0 ? undefined : opts
    let run
    try {
      run = await startChild(providerName, provider, `swarm · ${String(task.label)}`, prompt, agentOptions, parent, signal)
    } catch (error) {
      if (signal.aborted) return { status: 'failed', output: '', error: 'cancelled' }
      console.error('[dsh-plugin-swarm] worker start failed:', String(error && error.message ? error.message : error))
      return { status: 'failed', output: '', error: `start failed: ${String(error && error.message ? error.message : error)}` }
    }
    return settleRun(run)
  }

  /** Run items through workerFn with bounded concurrency, indexed results. */
  async function runBatch(items, workerFn, concurrency, signal) {
    const results = new Array(items.length)
    let index = 0
    async function thread() {
      while (index < items.length) {
        const slot = index++
        if (signal.aborted) {
          results[slot] = { status: 'failed', output: '', error: 'cancelled' }
          continue
        }
        results[slot] = await workerFn(items[slot], slot)
      }
    }
    const threads = Math.min(concurrency, items.length)
    await Promise.all(Array.from({ length: threads }, () => thread()))
    return results
  }

  async function runReview(providerName, provider, goal, modelOverrides, parent, signal, taskResults) {
    const prompt = reviewPrompt(goal, resultsText(taskResults))
    let run
    try {
      const schema = provider.capabilities !== undefined && provider.capabilities !== null && provider.capabilities.outputSchema === true ? REVIEW_SCHEMA : undefined
      run = await startChild(providerName, provider, 'swarm-reviewer', prompt, smartOptions(modelOverrides), parent, signal, schema)
    } catch (error) {
      return { verdict: '', feedback: [], error: `reviewer failed to start: ${String(error && error.message ? error.message : error)}` }
    }
    const settled = await settleStructured(run)
    const parsed = settled.ok
      ? (settled.structured !== undefined && settled.structured !== null ? settled.structured : parseJson(settled.text))
      : parseJson(settled.text)
    if (parsed !== undefined && parsed !== null && typeof parsed === 'object') {
      const verdict = typeof parsed.verdict === 'string' && parsed.verdict.length > 0 ? parsed.verdict : ''
      const feedback = Array.isArray(parsed.feedback)
        ? parsed.feedback
          .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.label === 'string' && typeof entry.redo === 'boolean' && typeof entry.note === 'string')
          .map((entry) => ({ label: entry.label, redo: entry.redo, note: entry.note }))
        : []
      return { verdict, feedback, error: '' }
    }
    if (settled.ok) return { verdict: settled.text.length > 0 ? settled.text.slice(0, 1200) : '', feedback: [], error: '' }
    return { verdict: '', feedback: [], error: `reviewer failed: ${settled.error}${settled.text.length > 0 ? ` — raw: ${settled.text.slice(0, 400)}` : ''}` }
  }

  async function runSynthesis(providerName, provider, goal, modelOverrides, parent, signal, taskResults, verdict) {
    const prompt = synthesisPrompt(goal, resultsText(taskResults), verdict)
    let run
    try {
      run = await startChild(providerName, provider, 'swarm-synthesizer', prompt, smartOptions(modelOverrides), parent, signal)
    } catch (error) {
      return `synthesis failed to start: ${String(error && error.message ? error.message : error)}`
    }
    const settled = await settleRun(run)
    if (settled.status === 'ok') return settled.output
    if (settled.output.length > 0) return `${settled.output}\n[synthesis ${settled.error}]`
    return `synthesis failed: ${settled.error}`
  }

  const toolRun = defineTool({
    name: 'swarm_run',
    description:
      'Act as the master of an agent swarm: decompose ONE goal into up to 16 parallel subtasks and fan them out to worker subagents, '
      + 'each with its own fresh context and a per-tier budget (fast = smallest budget, standard = inherits your model, smart = largest budget; '
      + 'use modelOverrides to give tiers different model ids). Optionally a smart reviewer grades every result and re-runs weak ones once '
      + 'with feedback, and a smart synthesizer merges all results into one final deliverable. The call blocks until the whole swarm '
      + 'finishes and returns a combined report. Prefer this tool when a goal splits into independent subtasks that benefit from '
      + 'parallel workers; you remain the master — plan the decomposition, judge the report.',
    parameters: {
      goal: { type: 'string', required: true, description: 'The overall objective the swarm must achieve together.' },
      tasks: {
        type: 'array',
        required: true,
        description:
          'Up to 16 parallel subtasks. Design each as INDEPENDENT work with no dependency on other workers; use review for quality control. '
          + 'Workers do not see this conversation, so every prompt must be self-contained.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            label: { type: 'string', required: true, description: 'Short unique worker label, e.g. "research-apis".' },
            prompt: { type: 'string', required: true, description: 'The complete, self-contained subtask for this worker.' },
            tier: {
              type: 'string',
              enum: ['fast', 'standard', 'smart'],
              default: 'standard',
              description: 'Worker budget tier: fast for cheap quick work, standard inherits your model, smart for the hardest subtasks.',
            },
            model: { type: 'string', description: 'Optional model id override for THIS worker (wins over tier mapping).' },
            provider: { type: 'string', description: 'Optional LLM provider route override for THIS worker. List valid ids with swarm_providers.' },
          },
        },
      },
      maxConcurrency: { type: 'integer', default: 4, description: 'How many workers run in parallel (1-16).' },
      modelOverrides: {
        type: 'object',
        additionalProperties: false,
        description: 'Optional per-tier model ids; smart also covers the reviewer and synthesizer. See swarm_providers for valid ids.',
        properties: {
          fast: { type: 'string', description: 'Model id for fast-tier workers this call.' },
          standard: { type: 'string', description: 'Model id for standard-tier workers this call.' },
          smart: { type: 'string', description: 'Model id for smart-tier workers, reviewer, and synthesizer this call.' },
        },
      },
      review: {
        type: 'boolean',
        default: false,
        description: 'After workers finish, spawn a smart reviewer that grades every result and returns per-task feedback; tasks marked redo rerun once with that feedback.',
      },
      synthesize: {
        type: 'boolean',
        default: true,
        description: 'After workers (and optional review) finish, spawn a smart synthesizer that merges every result into one final deliverable for you.',
      },
      providerName: {
        type: 'string',
        description: 'Optional subagent transport provider name (e.g. "spawn"). Defaults to the best available fresh-context provider.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          runId: { type: 'string', required: true },
          goal: { type: 'string', required: true },
          provider: { type: 'string', required: true },
          tasks: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                label: { type: 'string', required: true },
                tier: { type: 'string', required: true },
                status: { type: 'string', required: true },
                output: { type: 'string', required: true },
                error: { type: 'string', required: true },
                redone: { type: 'boolean', required: true },
              },
            },
          },
          review: { type: 'string', required: true },
          finalAnswer: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const lines = []
        lines.push(`Swarm run ${value.runId} (${value.provider}): ${value.tasks.length} worker task(s).`)
        for (const task of value.tasks) {
          let line = `- ${task.label} [${task.tier}]: ${task.status === 'ok' ? 'ok' : `${task.status}${task.error ? ` — ${task.error}` : ''}`}`
          if (task.redone) line += ' (redone after review)'
          lines.push(line)
        }
        if (value.review) lines.push(`Review verdict: ${value.review}`)
        lines.push('')
        if (value.finalAnswer) {
          lines.push('Final deliverable:')
          lines.push(value.finalAnswer)
        } else {
          lines.push('Worker outputs:')
          for (const task of value.tasks) {
            if (task.output) {
              lines.push('')
              lines.push(`--- ${task.label} ---`)
              lines.push(task.output)
            }
          }
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    presentCall: (args) => ({ card: 'generic', title: `Swarm · ${Array.isArray(args.tasks) ? String(args.tasks.length) : '?'} workers` }),
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) throw new Error('swarm_run requires a calling agent (exec.agent was undefined)')
      const signal = exec.signal
      const tasks = Array.isArray(args.tasks) ? args.tasks : []
      if (tasks.length === 0) throw new Error('swarm_run needs at least one task')
      if (tasks.length > cfg.maxTasks) throw new Error(`swarm_run supports at most ${cfg.maxTasks} tasks per call`)
      for (const task of tasks) {
        if (task === null || typeof task !== 'object' || typeof task.label !== 'string' || task.label.length === 0 || typeof task.prompt !== 'string' || task.prompt.length === 0) {
          throw new Error('every swarm task needs a non-empty "label" and "prompt" string')
        }
      }
      const providerName = pickProvider(args.providerName ?? cfg.providerName)
      if (providerName === undefined) {
        const available = ctx.subagents.list()
        if (args.providerName !== undefined || cfg.providerName !== undefined) {
          throw new Error(`configured subagent provider is not registered; available: ${available.length > 0 ? available.join(', ') : '(none)'}`)
        }
        throw new Error('no subagent provider is registered, so swarm workers cannot start')
      }
      const provider = ctx.subagents.getProvider(providerName)
      if (provider === undefined) throw new Error(`subagent provider "${providerName}" is not registered`)
      let concurrency = typeof args.maxConcurrency === 'number' ? Math.floor(args.maxConcurrency) : cfg.defaultMaxConcurrency
      if (!(concurrency >= 1)) concurrency = 1
      if (concurrency > 16) concurrency = 16
      const modelOverrides = args.modelOverrides !== undefined && args.modelOverrides !== null && typeof args.modelOverrides === 'object' ? args.modelOverrides : undefined
      const goal = String(args.goal)
      const runId = `swarm-${++seq}`
      active.set(runId, { runId, goal, taskCount: tasks.length })
      const taskResults = []
      try {
        const first = await runBatch(
          tasks,
          (task) => launchWorker(providerName, provider, task, goal, modelOverrides, parent, signal),
          concurrency,
          signal,
        )
        for (let i = 0; i < tasks.length; i++) {
          const task = tasks[i]
          const result = first[i]
          taskResults.push({
            label: String(task.label),
            tier: task.tier === 'fast' || task.tier === 'smart' ? task.tier : 'standard',
            status: result.status,
            output: result.output,
            error: result.error,
            redone: false,
            prompt: typeof task.prompt === 'string' ? task.prompt : '',
          })
        }
        let reviewText = ''
        if (args.review === true && !signal.aborted) {
          const review = await runReview(providerName, provider, goal, modelOverrides, parent, signal, taskResults)
          if (review.error) {
            reviewText = review.error
          } else {
            reviewText = review.verdict
            const byLabel = new Map()
            taskResults.forEach((task, i) => byLabel.set(task.label, i))
            const redoList = []
            for (const feedback of review.feedback) {
              if (feedback.redo !== true) continue
              const i = byLabel.get(feedback.label)
              if (i === undefined) continue
              redoList.push({ index: i, note: feedback.note })
            }
            if (redoList.length > 0 && !signal.aborted) {
              const redone = await runBatch(
                redoList,
                (item) => launchWorker(providerName, provider, tasks[item.index], goal, modelOverrides, parent, signal, item.note),
                concurrency,
                signal,
              )
              redone.forEach((result, k) => {
                const entry = taskResults[redoList[k].index]
                entry.status = result.status
                entry.output = result.output
                entry.error = result.error
                entry.redone = true
              })
            }
          }
        }
        let finalAnswer = ''
        if (args.synthesize !== false && !signal.aborted) {
          finalAnswer = await runSynthesis(providerName, provider, goal, modelOverrides, parent, signal, taskResults, reviewText)
        }
        history.push({
          runId,
          goal,
          provider: providerName,
          taskCount: tasks.length,
          tasks: taskResults.map((task) => ({ label: task.label, tier: task.tier, status: task.status })),
          finalAnswer: finalAnswer.length > 500 ? finalAnswer.slice(0, 500) : finalAnswer,
        })
        if (history.length > cfg.historyLimit) history.shift()
        const cleanTasks = taskResults.map(({ prompt: _prompt, ...task }) => task)
        return { runId, goal, provider: providerName, tasks: cleanTasks, review: reviewText, finalAnswer }
      } finally {
        active.delete(runId)
      }
    },
  })
  disposers.push(ctx.tools.register(toolRun))

  const toolStatus = defineTool({
    name: 'swarm_status',
    description: 'Show currently active and recently completed swarm orchestration runs started by the swarm plugin in this process.',
    parameters: {
      limit: { type: 'integer', default: 5, description: 'How many recent completed runs to return (1-20).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          active: { type: 'array', required: true, items: { type: 'json' } },
          recent: { type: 'array', required: true, items: { type: 'json' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Active swarms: ${String(value.active.length)}; recent completed: ${String(value.recent.length)}` }],
    },
    async execute(args) {
      let limit = typeof args.limit === 'number' ? Math.floor(args.limit) : 5
      if (!(limit >= 1)) limit = 1
      if (limit > 20) limit = 20
      return { active: Array.from(active.values()), recent: history.slice(-limit).reverse() }
    },
  })
  disposers.push(ctx.tools.register(toolStatus))

  const toolProviders = defineTool({
    name: 'swarm_providers',
    description: 'List the subagent transport providers and LLM routes available for swarm workers, so per-tier model overrides can be chosen.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          providers: { type: 'array', required: true, items: { type: 'json' } },
          llmProviders: { type: 'array', required: true, items: { type: 'json' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Subagent providers: ${value.providers.map((provider) => provider.name).join(', ')}. LLM routes: ${value.llmProviders.map((provider) => provider.id).join(', ')}`,
      }],
    },
    async execute() {
      const providers = ctx.subagents.list().map((providerName) => {
        const provider = ctx.subagents.getProvider(providerName)
        if (provider === undefined) return { name: providerName, available: false }
        const caps = provider.capabilities !== undefined && provider.capabilities !== null ? provider.capabilities : {}
        return {
          name: providerName,
          available: true,
          inheritsParentContext: provider.inheritsParentContext === true,
          capabilities: {
            outputSchema: caps.outputSchema === true,
            depthLimit: caps.depthLimit === true,
            toolFilter: caps.toolFilter === true,
            persona: caps.persona === true,
          },
        }
      })
      const llm = ctx.get('llm')
      const llmProviders = []
      if (llm !== undefined && typeof llm.listProviders === 'function') {
        const list = llm.listProviders()
        if (Array.isArray(list)) {
          for (const provider of list) {
            if (provider !== null && typeof provider === 'object' && typeof provider.id === 'string') {
              llmProviders.push({ id: provider.id, name: typeof provider.name === 'string' ? provider.name : provider.id })
            }
          }
        }
      }
      return { providers, llmProviders }
    },
  })
  disposers.push(ctx.tools.register(toolProviders))

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // already unregistered
      }
    }
    disposers.length = 0
    for (const run of Array.from(liveRuns)) {
      try {
        Promise.resolve(run.dispose()).catch(() => {})
      } catch {
        // ignore
      }
    }
    liveRuns.clear()
    active.clear()
  })

  console.log(`[dsh-plugin-swarm] active — subagent providers: ${ctx.subagents.list().join(', ') || '(none)'}`)
}

export default { name, inject, apply }
