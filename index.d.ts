/**
 * Type declarations for dsh-plugin-swarm.
 *
 * The runtime package has no build step and no runtime dependencies; these
 * declarations exist for editor support and for consumers who type-check
 * against the plugin API.
 */
import type { Context } from '@deepseek-ai/cordis'

export interface SwarmTierBudgets {
  /** Max output tokens per model request for fast-tier workers. Default 4096. */
  fast?: number
  /** Max output tokens for standard-tier workers. 0 = inherit the parent agent's budget. Default 0. */
  standard?: number
  /** Max output tokens for smart-tier workers, the reviewer, and the synthesizer. Default 16384. */
  smart?: number
}

export interface SwarmConfig {
  /**
   * Preferred subagent transport provider (e.g. "spawn" or "fork").
   * Defaults to auto-selection: "spawn", then "fork", then the first
   * registered provider.
   */
  providerName?: string
  /** Hard cap on tasks per swarm_run call (1-32). Default 16. */
  maxTasks?: number
  /** How many completed runs swarm_status remembers (0-100). Default 20. */
  historyLimit?: number
  /** Default maxConcurrency when a swarm_run call omits it (1-16). Default 4. */
  defaultMaxConcurrency?: number
  /** Per-tier max-output-token budgets. */
  tierBudgets?: SwarmTierBudgets
}

export declare const name: 'dsh-plugin-swarm'
export declare const inject: ['subagents', 'tools']
export declare function apply(ctx: Context, config?: SwarmConfig): void

declare const plugin: { name: typeof name; inject: typeof inject; apply: typeof apply }
export default plugin
