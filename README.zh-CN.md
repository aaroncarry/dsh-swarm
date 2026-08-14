# dsh-plugin-swarm

[![npm version](https://img.shields.io/npm/v/@aaroncarry/dsh-plugin-swarm)](https://www.npmjs.com/package/@aaroncarry/dsh-plugin-swarm)
[![license](https://img.shields.io/github/license/aaroncarry/dsh-swarm)](./LICENSE)

[English](./README.md) | **简体中文**

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的主从式（master/worker）多智能体协同编排插件。

高智力**主 agent**（会话中的 agent）将一个目标分解为并行子任务，分发给拥有不同智力预算的 **worker 子智能体**。Worker 通过 `subagents` 服务在其独立的全新上下文中运行；可选的智能**评审者**对每个结果评分并对不合格任务带反馈重做一次；可选的智能**综合者**将所有结果合并为一份交付物。

```
                        ┌─────────────────────────────┐
                        │  主 agent（当前会话）        │
                        │  swarm_run(goal, tasks…)     │
                        └──────────────┬──────────────┘
              ┌────────────────────────┼────────────────────────┐
              ▼                        ▼                        ▼
      ┌──────────────┐         ┌──────────────┐         ┌──────────────┐
      │ worker (fast)│  ...    │worker (std)  │  ...    │worker (smart)│   ≤16 个任务
      └──────┬───────┘         └──────┬───────┘         └──────┬───────┘
             └───────────┬────────────┴───────────┬────────────┘
                         ▼                        ▼
              ┌──────────────────┐      ┌──────────────────────┐
              │ reviewer (smart) │ ───► │ 对标记任务重做         │ （可选）
              └────────┬─────────┘      └──────────┬───────────┘
                       └───────────────┬───────────┘
                                       ▼
                         ┌──────────────────────────┐
                         │ synthesizer (smart)      │ （可选，默认开启）
                         │ → 一份最终交付物          │
                         └──────────────────────────┘
```

## 特性

- **按智力分级**：`fast`（小输出预算）、`standard`（继承主 agent 的模型）、`smart`（最大预算，用于最难的步骤、评审者与综合者）。
- **按层级或按任务的模型覆盖**：把廉价层指向廉价模型，把 `smart` 留给你最强的模型。
- **评审 + 重做**：评审者返回结构化结论和逐任务反馈；被标记 `redo` 的任务带着评审意见再执行一次。
- **综合合成**：产出一份连贯的最终交付物，并注明每个 worker 的贡献。
- **叶子安全**：worker 通过 `toolFilter`（若 provider 支持）被禁用 swarm 工具，并在提示中明确不得自行启动 swarm。
- **可观测**：`swarm_status` 查看活跃/历史运行；`swarm_providers` 列出可用传输与 LLM 路由。

## 安装

插件是一个普通的 cordis 组合行，通过 dsh profile 补丁层挂载。按需选择包来源：

```sh
# A. 从 npm 安装（推荐；已发布为 @aaroncarry/dsh-plugin-swarm）
dsh plugin --profile web add @aaroncarry/dsh-plugin-swarm

# B. 直接从 GitHub 安装
dsh plugin --profile web add github:aaroncarry/dsh-swarm

# C. 本地目录安装（拷贝模式；改代码后需重新 update）
dsh plugin --profile web add file:../dsh-swarm

# 2. 将下面这行加入 profile 补丁层
#    $DSH_HOME/profiles/web/cordis.patch.yml  （参见 cordis.patch.example.yml）
```

组合行（所有配置项均可选）：

```yaml
- insert:
    - id: swarm
      name: '@aaroncarry/dsh-plugin-swarm'
      config:
        providerName: spawn
```

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `providerName` | 自动（`spawn` > `fork` > 第一个） | 所有 swarm 子智能体的传输 provider |
| `maxTasks` | `16` | 单次 `swarm_run` 的任务数上限（1–32） |
| `historyLimit` | `20` | `swarm_status` 记住的已完成运行数（0–100） |
| `defaultMaxConcurrency` | `4` | 调用未指定 `maxConcurrency` 时的并行 worker 数 |
| `tierBudgets.fast` | `4096` | fast 层每次模型请求的最大输出 token |
| `tierBudgets.standard` | `0` | `0` = 继承主 agent 的预算 |
| `tierBudgets.smart` | `16384` | smart 层 / 评审者 / 综合者的最大输出 token |

profile 补丁层会被 dsh 启动监视器热应用；否则重启 dsh。

## 工具

### `swarm_run`

把一个目标分解为最多 16 个独立子任务，以受控并发运行，然后可选评审与综合。阻塞直到整个 swarm 结束。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `goal` | string（必填） | 总体目标 |
| `tasks` | array（必填） | `{ label, prompt, tier?, model?, provider? }` —— prompt 必须自包含（worker 看不到会话上下文） |
| `maxConcurrency` | integer（默认 4） | 并行 worker 数，1–16 |
| `modelOverrides` | object | `{ fast?, standard?, smart? }` 模型 id；`smart` 同时覆盖评审者与综合者 |
| `review` | boolean（默认 false） | 智能评审者评分每个结果；被标记的任务带反馈重做一次 |
| `synthesize` | boolean（默认 true） | 智能综合者把结果合并为一份最终交付物 |
| `providerName` | string | 覆盖行配置的传输 provider |

返回 `{ runId, goal, provider, tasks: [{ label, tier, status, output, error, redone }], review, finalAnswer }`。

### `swarm_providers`

列出已注册的 subagent provider（含能力）与 LLM 路由——用于挑选合法的 `model` / `provider` 覆盖值。

### `swarm_status`

列出当前活跃与最近完成的 swarm 运行（`limit`，默认 5，最大 20）。

## 环境要求

- dsh 部署的主机组合提供 `subagents`（至少一个 provider，如 `spawn`）与 `tools`。
- `llm` 服务为可选，仅用于丰富 `swarm_providers` 的返回。

## 开发

无构建步骤——包直接发布源码。本地迭代：

```sh
node --check src/index.js        # 语法检查
dsh plugin --profile web add link:../dsh-plugin-swarm   # 软链安装（需依赖可解析）
```

运行时零依赖：一切通过 cordis 服务注入。`peerDependencies` 中的 `@deepseek-ai/dsh-*` 是对部署契约的说明；任何真实部署都已自带这些包。

## 许可证

MIT —— 参见 [LICENSE](./LICENSE)。
