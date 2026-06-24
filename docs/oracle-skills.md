# Oracle Skills 系统生成与消融指南

本文档说明当前 Oracle Skills 系统的设计、生成方式、约束、消融策略和人工实验入口。当前实验不再使用旧版 `skill-learning` 闭环；新的 Skills 生成、渲染和消融应统一使用 `src/oracle-skills/`，长实验结果一般写入 `output/oracle-skill-ablation/`。

## 1. 系统定位

Oracle Skills 系统的目标不是训练一个新 Agent，而是把一个任务的标准实现知识蒸馏成 Claude 原生 Skills 可读取的本地说明包，然后通过删除部分知识来做 skills ablation。

完整链路分为 4 层：

| 阶段 | 入口 | 主要产物 | Agent 能看到什么 |
| --- | --- | --- | --- |
| Skills 生成 | `bun src/oracle-skills/cli.ts generate` | `skills/<skill>/SKILL.md`、资源、脚本、manifest | 作者 Agent 可读当前任务 `public` 和 `std_code` |
| Host 校验 | `validate` / `materialize` | 校验报告 | 不调用测评 Agent |
| 变体渲染 | `render` / `ablate` / runner | 匿名 skill 变体 | 只保留启用 operation 对应内容 |
| 评测运行 | `src/harness/evaluation/cli.ts` 或 runner | `eval/<variant>/...` | Solver Agent 只看到渲染后的 Claude Skill、`public/`、`workspace/`、`outputs/`、`logs/agent/` |

这里的 “Skill” 复用 Claude 原生 Skills 系统：评测时不是把知识拼进普通 prompt，而是通过 `--enable-skills --skills-dir ... --skill-name ...` 暴露为 native SkillTool。Agent 需要主动调用 skill；skill 被调用后，内容才进入上下文。

## 2. 相比普通测评框架的差异

### 2.1 Skills 生成模块换了一套 system prompt

普通测评框架的 solver 目标是完成任务并提交 `outputs/`。Skills 生成阶段使用单独的 author Agent，其 system prompt 是 `ORACLE_SKILL_AUTHOR_SYSTEM_PROMPT`，核心约束如下：

- 这是可信离线作者阶段，不是评测 solver。
- 可以读取当前任务的 `README.md`、`output_schema.json`、`visible_data/` 和 `std_code/`，用于抽取标准实现知识。
- 不允许运行 judge，不允许优化最终输出，不允许把自己当作 solver。
- 必须通过 `StructuredOutput` 返回结构化 draft，而不是直接写最终 skill 文件。
- 生成的 solver-facing 文件不能暴露 `std_code`、`.judge_private`、`ground_truth`、`reference_outputs`、`private_judge`、绝对本地路径或私有目录来源。
- `skill_description` 和 `skill_overview` 不能写全局 pipeline / data flow 总结，也不能包含 operation ID；可删除知识必须留在各自 operation section 里。

生成 prompt 还明确要求作者 Agent 把标准实现拆成 8-14 个原子操作（默认和硬上限都是 14），并把依赖写成有向无环图（DAG）。

### 2.2 Author harness 也与评测 harness 不同

作者阶段使用 `QueryEngineOracleSkillAuthorSession`，但它不是普通 eval session：

- 使用 `customSystemPrompt`，并关闭默认 user/system context：`includeDefaultUserContext: false`、`includeSystemContext: false`。
- 工具池只保留 `Read`、`Write`、`Edit`、`MultiEdit`、`Glob`、`Grep`、`Bash`、`TodoWrite` 和合成的 `StructuredOutput`。
- 没有 slash commands、MCP、subagents，也不会触发 judge。
- `authorCanUseTool` 限制读取范围：当前任务公开材料、当前任务 `std_code/`、author workspace。
- 写入只能发生在 `.authoring/workspace`。
- Bash 禁止 `curl`、`wget`、`ssh`、`scp`、`rsync`、安装命令、删除/移动命令，以及包含私有路径片段的命令。

这些约束的目的，是允许作者 Agent 学习标准实现，同时保证生成后的 skill 不携带私有路径、答案文件或 judge 信息。

## 3. 术语和目录

| 名称 | 含义 |
| --- | --- |
| bundle | 一次完整 Skills 生成产物目录，例如 `output/oracle-skills/<task>-gpugeek-opus` |
| operation / op | 一个可独立删除的原子知识单元，例如“读取输入参数”“频率网格约定”“输出写入” |
| manifest | `oracle_skill_manifest.json`，记录 operation ID、标题、依赖、资源、脚本和消融优先级 |
| rendered variant | 通过 `render` 删除部分 op 后生成的 solver-facing skill 目录 |
| variant manifest | 变体元数据，记录启用/删除的 op，只供实验记录使用，不应暴露给 solver |
| ablation priority | Official automatic deletion order; higher values are attempted earlier. |
| fixed drop | Exact user-specified `--drop-ops` set; evaluated once and not used as a greedy seed. |

典型 bundle 结构：

```text
output/oracle-skills/<bundle>/
  skills/<skill_name>/
    SKILL.md
    resources/
    scripts/
  oracle_skill_manifest.json
  source_index.json
  author_draft.json
  .authoring/
    prompts/
    logs/
    workspace/
```

典型消融实验结构：

```text
output/oracle-skill-ablation/<exp>/
  variants/v_<hash>/
    skills/<skill_name>/SKILL.md
  metadata/variants/v_<hash>.json
  metadata/variants/v_<hash>.eval_command.txt
  configs/v_<hash>.json
  eval/v_<hash>/
  candidate_order.json
  ablation_results.jsonl
  ablation_summary.json
```

## 4. 从零生成一个 Skill

### 4.1 预览 author prompt

先生成 prompt，检查作者指令、任务上下文、允许读取范围和 `max_operation_count`：

```bash
bun src/oracle-skills/cli.ts prompt \
  --task SSNP_ODT \
  --out output/oracle-skills/SSNP_ODT-prompts \
  --max-operations 14
```

输出：

```text
output/oracle-skills/SSNP_ODT-prompts/author.system.md
output/oracle-skills/SSNP_ODT-prompts/author.user.md
```

如果是从 WSL 跑长实验，建议直接使用 Linux Bun：

```bash
/home/admin/.bun/bin/bun src/oracle-skills/cli.ts prompt ...
```

### 4.2 生成 query-engine oracle skill bundle

```bash
bun src/oracle-skills/cli.ts generate \
  --task SSNP_ODT \
  --out output/oracle-skills/SSNP_ODT-gpugeek-opus \
  --skill-name oracle-ssnp_odt \
  --mode query-engine \
  --max-turns 12 \
  --max-operations 14 \
  --model-profile gpugeek-claude-opus
```

常用参数：

| 参数 | 说明 |
| --- | --- |
| `--task` | `tasks/` 下的任务 ID |
| `--tasks-dir` | 任务根目录，默认 `tasks` |
| `--out` | bundle 输出目录 |
| `--skill-name` | 生成的 Claude Skill 名称；不指定时自动用 `oracle-<task>` |
| `--mode query-engine` | 使用作者 Agent 读取材料并返回结构化 draft |
| `--mode template` | 只生成模板式 skill，适合调试流程，不适合作为最终实验依据 |
| `--max-turns` | 作者 Agent 最大 turn 数，默认 12 |
| `--max-operations` | 原子操作上限，最大 14 |
| `--model-profile` | 从 `config/eval-model-profiles.local.json` 读取模型配置 |
| `--prompt-out` | 额外保存 author prompt 的位置 |

复杂任务可以把 `--max-turns` 提高到 50；这只影响作者 Agent 的生成预算，不改变后续 eval 的 `--max-rounds` 或 solver turn 限制。

### 4.3 校验 bundle

```bash
bun src/oracle-skills/cli.ts validate \
  --bundle output/oracle-skills/SSNP_ODT-gpugeek-opus
```

校验通过后，才应该用于消融实验。失败时优先查看 `issues` 中的 `code`、`path`、`operationId`。

## 5. Skills 生成要求

### 5.1 原子操作定义

一个 operation 是最小的、连贯的任务知识单元。它可以是：

- 公开任务契约和输出格式。
- 输入数组、参数、单位、dtype、shape 或 case ID 读取约定。
- 坐标系、轴顺序、裁剪、padding、归一化、频率网格、边界处理。
- 物理模型、前向算子、传播算子或核心公式。
- 初始化、优化目标、正则项、迭代更新或停止条件。
- 后处理、归一化、clip、mask、输出写入。
- 轻量 probe、smoke test 或最终格式检查。

每个 operation 必须满足：

- 在 `skill_md` 中至少出现一次，不能只存在于资源或脚本里。
- 可以通过 `SKILL.md` anchor block 和其拥有的资源/脚本被完整删除。
- 有自然语言标题，供 solver 阅读；不要用 `op_NNN_slug` 作为标题。
- 依赖只能指向更早出现的 operation。
- 资源/脚本只能引用自己的内容，或引用已经声明为依赖的 operation 内容。
- `enabled_by_default` 应为 `true`，除非有明确理由不默认启用。

### 5.2 Operation 字段

`oracle_skill_manifest.json` 中每个 operation 的核心字段如下：

| 字段 | 用途 | 是否暴露给 solver |
| --- | --- | --- |
| `id` | 内部稳定索引，格式 `op_NNN_slug` | 渲染后必须隐藏 |
| `title` | 自然语言标题，用于生成 `SKILL.md` section 标题 | 暴露 |
| `kind` | `contract`、`data_loading`、`physics_model` 等分类 | 不直接暴露 |
| `depends_on` | DAG 依赖关系 | 不直接暴露 |
| `ablation_priority` | 当前叶子节点之间的删除排序 | 不直接暴露 |
| `resources` | 该 op 拥有的 Markdown 资源 | 路径会匿名化后暴露 |
| `scripts` | 该 op 拥有的 helper/probe/validator | 路径会匿名化后暴露 |
| `source_refs` | 作者阶段来源索引 | 不暴露 |

`op_NNN_slug` 是内部映射和消融索引，不是给 solver 的语义提示。`NNN` 可以辅助人工阅读生成顺序，但真正的删除顺序由“当前叶子节点 + `ablation_priority`”决定。

### 5.3 生成 prompt 强制约束

作者 Agent 的 prompt 强制强调以下几点：

- 从标准实现中抽取高保真知识，保留常量、轴顺序、reshape、FFT 约定、归一化、坐标原点、crop window、dtype、clip、mask、输出命名等细节。
- 不要把实现压缩成一个“参考实现总结”大 operation。
- 不要把任务特定知识替换成泛泛建议。
- 不要在 `skill_description` 或 `skill_overview` 中写完整 pipeline，因为这样删除某个 op 后，Agent 仍可能从全局概述中恢复被删知识。
- operation details 必须只存在于该 operation 自己的 removable section 中。
- 如果两个 operation 共享知识，要么抽成前置依赖，要么少量重复必要上下文；不要跨 op 引用未声明的 ID、资源或脚本。

### 5.4 Host 侧检查

生成后，`materialize` 和 `validate` 会做 host 侧检查：

- `op` ID 必须匹配 `op_[0-9]{3}_[a-z0-9_]+`（draft 阶段）。
- operation 数量不能超过 14。
- `depends_on` 必须是 DAG，并且依赖只能指向更早的 operation。
- 资源必须在 `resources/` 下，脚本必须在 `scripts/` 下。
- 资源文件名和脚本文件名必须以前缀对应所属 operation。
- solver-facing 文本不能包含 forbidden token。
- `skill_description`、`skill_overview` 不能包含 op ID、`ablatable` 或全局 `pipeline:` / `data flow:` 摘要。
- 某个 operation 引用了其他 op ID 时，必须在 `depends_on` 中声明对应依赖。

## 6. 路径匿名和 index 引用

### 6.1 生成阶段：ID 只做内部索引

生成阶段需要稳定 ID 来做 manifest、anchor、资源归属和消融记录。推荐格式：

```text
op_010_public_contract
op_020_load_inputs
op_030_geometry_convention
```

但这些 ID 不能作为 solver-facing 内容的一部分。Skill section 标题应该是自然语言，例如：

```markdown
## Public task contract and output schema
## Load measurements and scalar parameters
## Frequency grid and Stolt mapping convention
```

这样做的目的，是让 Agent 看到知识内容，而不是看到“第几个 op 被保留/删除”。

### 6.2 渲染阶段：删除元信息并重命名资源

`render` 会做以下匿名化处理：

- 删除 `<!-- ORACLE_OP_START ... -->` / `<!-- ORACLE_OP_END ... -->` 标记。
- 删除被禁用 operation 对应的整个 Markdown block。
- 删除被禁用 operation 拥有的 `resources/` 和 `scripts/`。
- 将保留资源重命名为 `resources/resource_001.md`、`resources/resource_002.md`。
- 将保留脚本重命名为 `scripts/script_001.py`、`scripts/script_002.py`。
- 重写 `SKILL.md`、资源和脚本中的 asset 引用。
- 扫描渲染结果的路径和内容，发现 op ID、`ORACLE_OP_START/END`、`drop_`、`enabled_ops`、`disabled_ops`、`ablatable`、forbidden token 等直接报错退出。

因此，消融结果中“删除了哪个 op”的信息只存在于外部 metadata 和实验记录里，不应该进入 solver 的可见目录。

### 6.3 变体目录匿名

静态消融和 frontier plan 会使用哈希名：

```text
variants/v_<12位hash>/
metadata/variants/v_<12位hash>.json
```

`v_<hash>` 由启用 op 集合计算，避免目录名暴露 `drop_op_050` 之类信息。外部 `metadata/variants/*.json` 可以记录 `enabled_ops` / `disabled_ops`，但不要把 metadata 目录挂到 solver 可读路径下。

如果手工写或手工修改 `SKILL.md`，用户需要负责维护 `ORACLE_OP_START/END` 注释的成对正确性；缺少 anchor 时 `validate` 会失败。只要进入正式评测，solver-facing 变体里不能保留这些 anchor 或任何 op ID。

## 7. Dependency Metadata And Deletion Order

### 7.1 Current `depends_on` Semantics

`depends_on` remains in the manifest for human audit and authoring context, but it no longer controls official ablation deletion.

Current rules:

- `render --drop-ops` removes exactly the requested operations.
- Drop sets are not checked against dependency closure.
- Automatic `ablate` does not compute DAG leaves or unlock operations by dependency layer.
- If a predecessor is deleted while a dependent operation remains, that is a valid experiment state; eval decides whether it still works.

### 7.2 Priority Greedy Deletion

Official automatic ablation uses one order only:

1. Take all `enabled_by_default: true` operations.
2. Sort by `ablation_priority` descending, then op id ascending for ties.
3. Candidate drop set = accepted cumulative drop set + current candidate op.
4. If eval passes, add the op to the accepted cumulative drop set.
5. If eval fails or is inconclusive, do not add the op and continue to the next priority candidate.

`op_NNN` is only an internal index for humans; it is not the deletion order.

### 7.3 User-Specified Drop Sets

When the user passes `--drop-ops`, the mode is fixed drop: render and evaluate exactly that drop set once. It is not a greedy seed and does not continue to other operations.

```bash
bun src/oracle-skills/cli.ts render \
  --bundle output/oracle-skills/<bundle> \
  --out output/oracle-skill-ablation/manual-v1 \
  --drop-ops op_020_child,op_030_leaf
```

Exact deletion is now the only `--drop-ops` behavior.

## 8. 变体渲染和评测使用

### 8.1 手工渲染删除集合

`--drop-ops` 支持逗号分隔字符串、文本文件或 JSON 数组：

```bash
bun src/oracle-skills/cli.ts render \
  --bundle output/oracle-skills/SSNP_ODT-gpugeek-opus \
  --out output/oracle-skill-ablation/manual-v1 \
  --drop-ops op_090_extract_forward,op_120_smoke_probe
```

也可以指定保留集合：

```bash
bun src/oracle-skills/cli.ts render \
  --bundle output/oracle-skills/SSNP_ODT-gpugeek-opus \
  --out output/oracle-skill-ablation/manual-enabled \
  --enabled-ops enabled_ops.json
```

`--enabled-ops` 和 `--drop-ops` 互斥。

### 8.2 把渲染后的 Skill 用于 eval

`render` 会在 metadata 旁边写一个 eval command 片段：

```text
metadata/variants/v_<hash>.eval_command.txt
```

内容类似：

```text
--enable-skills --skills-dir <variant>/skills --skill-name <skill_name>
```

直接跑单个任务时可以这样使用：

```bash
bun src/harness/evaluation/cli.ts \
  --task SSNP_ODT \
  --runs-dir output/oracle-skill-ablation/manual-v1/eval \
  --max-rounds 5 \
  --timeout-seconds 7200 \
  --temperature 1 \
  --thinking disabled \
  --network-policy disabled \
  --enable-skills \
  --skills-dir output/oracle-skill-ablation/manual-v1/skills \
  --skill-name oracle-ssnp_odt
```

评测时 solver 只应该看到渲染后的 `skills/`、该 run 的 `public/`、`workspace/`、`outputs/` 和 `logs/agent/`。不要把 bundle 根目录或 `metadata/` 暴露给 solver。

### 8.3 Preview Or Generate Ablation Variants

Preview the candidate plan without running eval:

```bash
bun src/oracle-skills/cli.ts ablate \
  --bundle output/oracle-skills/SSNP_ODT-gpugeek-opus \
  --out output/oracle-skill-ablation/SSNP_ODT-plan \
  --dry-run
```

If `--task` is omitted, `ablate` remains a static variant renderer: it emits full, single-drop, and priority-ordered cumulative greedy-step variants.

## 9. Automatic Ablation Strategy

The official long-running entrypoint is the TypeScript CLI; Python helper runners are no longer required for the current flow.

```bash
bun src/oracle-skills/cli.ts ablate \
  --bundle output/oracle-skills/SSNP_ODT-gpugeek-opus \
  --out output/oracle-skill-ablation/SSNP_ODT-priority-greedy \
  --task SSNP_ODT \
  --model-profile gpugeek-claude-opus
```

Runtime behavior:

1. Evaluate the full-skill baseline first; stop if baseline fails.
2. Build candidates by `ablation_priority` descending.
3. Render each candidate from the current accepted cumulative drop set plus the candidate op.
4. Accept the deletion only when eval passes.
5. Skip failed or inconclusive candidates and continue with the next priority candidate.
6. Write `candidate_order.json`, `ablation_results.jsonl`, and `ablation_summary.json`.

Fixed-drop run:

```bash
bun src/oracle-skills/cli.ts ablate \
  --bundle output/oracle-skills/SSNP_ODT-gpugeek-opus \
  --out output/oracle-skill-ablation/SSNP_ODT-fixed-drop \
  --task SSNP_ODT \
  --drop-ops op_050_incident,op_070_q_operator \
  --model-profile gpugeek-claude-opus
```

Fixed drop evaluates only the specified drop set.

## 10. Manual Operations

### 10.1 Priority Greedy Deletion

When the user asks to delete by priority, use the official `ablate --task` entrypoint. Do not compute DAG leaves and do not require dependency closure.

Correct flow:

1. Inspect `ablation_priority` in the manifest.
2. Attempt candidates from high to low priority.
3. Render anonymous variants.
4. Run eval serially by default.
5. Accept a deletion only on pass; otherwise keep the previous accepted drop set and try the next op.

### 10.2 Manual Drop Combinations

Use fixed drop to test a specific hypothesis, for example whether `{50,70}` still passes:

```bash
bun src/oracle-skills/cli.ts ablate \
  --bundle output/oracle-skills/<bundle> \
  --out output/oracle-skill-ablation/<exp> \
  --task <task_id> \
  --drop-ops op_050_x,op_070_y
```

Guidelines:

- Do not put `drop_050_070` or op ids in solver-facing paths.
- Keep drop-set metadata in `metadata/`, `candidate_order.json`, `ablation_summary.json`, or experiment notes.
- Run high-load experiments serially unless concurrency is explicitly safe.

### 10.3 Render-Only Variants

Use `render --drop-ops` when you need only a skill variant and do not want to run eval. The command deletes exactly the requested operations and does not cascade through dependents.

```bash
bun src/oracle-skills/cli.ts render \
  --bundle output/oracle-skills/<bundle> \
  --out output/oracle-skill-ablation/<exp>/variants/v_manual_a \
  --drop-ops op_040_crop_transpose
```

### 10.4 人工修 skill

如果用户手工改生成出的 bundle：

- 可以改自然语言标题，让标题总结实际知识内容。
- 不要把 `op_NNN` 写到 solver-facing 标题或正文。
- 保留 `ORACLE_OP_START/END` 注释，使 `render` 能完整删除对应 block。
- 每个资源/脚本仍应归属某个 op。
- 改完必须运行 `validate`。
- 再渲染一个变体，确认 solver-facing 目录中没有 op ID 或删除元信息。

## 11. WSL 运行要求

从 Windows PowerShell 启动 WSL 长实验时，不要在 WSL 脚本里直接调用裸 `bun`。非交互 WSL 可能继承 Windows PATH，导致 `bun` 被解析到 Windows Bun。此时 eval 会错误地选择 Windows runtime：

```text
public/envs/runtime/.venv/Scripts/python.exe
```

正确做法是固定 Linux Bun：

```bash
BUN=/home/admin/.bun/bin/bun
export PATH="$HOME/.bun/bin:$PATH"

if [ "$("$BUN" -e 'process.stdout.write(process.platform)')" != "linux" ]; then
  echo "ERROR: expected Linux Bun for WSL eval" >&2
  exit 1
fi

"$BUN" src/oracle-skills/cli.ts render ...
"$BUN" src/harness/evaluation/cli.ts ...
```

启动后检查 `logs/trajectory.clean.jsonl` 首行。WSL 正确运行时，`runtime_python` 必须是：

```text
public/envs/runtime/.venv-posix/bin/python
```

如果看到 Windows venv，应停止该轮，不要作为有效消融证据。

## 12. 结果文件和判定

主要结果文件：

| 文件 | 说明 |
| --- | --- |
| `candidate_order.json` | Priority candidate order and fixed-drop input |
| `ablation_results.jsonl` | One execution record per evaluated candidate |
| `ablation_summary.json` | Status, accepted drop set, and result summary |
| `configs/*.json` | Eval config for each variant |
| `metadata/variants/*.json` | 变体 manifest，记录启用/禁用 op |
| `eval/<run>/logs/trajectory.clean.jsonl` | Agent 可见轨迹的干净版 |
| `eval/<run>/logs/run_summary.json` | judge 汇总结果 |

结果分类：

| 类型 | 含义 |
| --- | --- |
| `pass` | judge 通过，reward 为 1 |
| `valid_fail` | 无联网污染且有效失败，包括 judge fail 或 timeout |
| `inconclusive` | 缺 summary、infra error、污染检查失败或无法确认有效失败 |

联网污染检查会扫描 clean trajectory 中的 Web 工具，以及 Bash 里的 `curl`、`wget`、`ssh`、`scp`、`rsync`。污染结果不能算有效消融失败。

## 13. 泄露与作弊审计清单

每次发现异常成功时，应区分“Agent 直接作弊”和“实验元信息泄露”。建议检查：

1. `trajectory.clean.jsonl` 中 Agent 的 `tool_call` 是否访问 `.judge_private`、`ground_truth`、`reference_outputs`、`std_code`、`evaluation/`、私有答案或父目录。
2. `workspace/`、`outputs/`、`logs/agent/` 是否硬编码私有路径或答案数组。
3. 渲染后的 `skills/` 路径和内容是否包含 `op_`、`drop_`、`enabled_ops`、`disabled_ops`、`ORACLE_OP_START/END`。
4. run 目录名、skill 目录名是否暴露删除集合；正式实验应使用匿名名。
5. judge feedback 是否只给 metric status，还是泄露了 metric value / full diff / reference 信息。

注意：`run_events.jsonl` 或 `trajectory.raw.jsonl` 可能包含 harness 内部的 `.judge_private/resultPath`，这不等于 Agent 访问了私有文件。判断作弊时应以 Agent tool call 输入、tool result 可见内容和最终 workspace 代码为准。

## 14. Recommended Workflow

1. Generate author prompts with `prompt`; inspect task context and `max_operation_count`.
2. Generate the bundle with `generate --mode query-engine`.
3. Validate with `validate`.
4. Inspect `oracle_skill_manifest.json`; verify operation count, titles, and priorities. Treat `depends_on` as audit metadata only.
5. Render a full variant or a small drop set; verify solver-facing `SKILL.md` has no op metadata.
6. In WSL, pin `/home/admin/.bun/bin/bun` and verify `runtime_python`.
7. Preview candidate order with `ablate --dry-run`.
8. Run official priority greedy ablation with `ablate --task`.
9. Run known hypothesis combinations with `ablate --task --drop-ops ...`.
10. Report accepted drop set, `run_summary.json`, and trajectory leak-check outcome.

## 15. 常见问题

### 删除单个 op 成功，删除两个 op 失败，是否矛盾？

不一定。两个 op 可能携带互补冗余：单删时另一个 op 仍提供关键锚点；一起删除后缺少两个锚点，Agent 无法恢复数值约定或输出语义。这类现象正是组合消融要观察的内容。

### Why can a dependent operation remain after its predecessor is deleted?

That is the current official behavior. `--drop-ops` removes exactly the requested operations, and `depends_on` does not trigger cascade deletion. Eval decides whether the remaining content is still usable; missing knowledge should surface as `valid_fail` or `inconclusive`.

### 匿名化会不会增加 Agent 读取难度？

正常不会。Agent 读取的是自然语言标题和内容，不需要知道 op ID。资源路径被改为 `resource_001.md` / `script_001.py` 只会降低路径语义泄露，不影响按 skill 指引读取。真正影响可用性的是 operation 内容是否自洽、依赖是否完整、资源引用是否被正确重写。

### 能不能在完整 overview 里写 pipeline？

不能。完整 pipeline 如果写在不可删除的 overview 中，会让被删除 operation 的知识仍然泄露给 Agent。overview 只应说明这是一个任务专用 skill，以及如何按 section 使用；具体 pipeline、公式和约定必须放进可删除的 operation section。

### 什么时候需要人工修 ORACLE_OP 注释？

只有手工编辑 bundle 的 `SKILL.md` 时需要。生成器会自动为 draft operation materialize anchor；但如果人工移动 section、合并 section 或重写标题，必须保证每个 operation 的 `ORACLE_OP_START/END` 成对包住完整可删除内容。正式渲染后这些注释会被移除。
