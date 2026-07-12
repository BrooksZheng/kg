# RFC-001 · Project Knowledge Growth Protocol

- 状态:**draft**(待人确认;确认后改 `confirmed` 并开始实现)
- 来源:ChatGPT 设计对话([分享链接](https://chatgpt.com/share/6a53318a-c9f0-83ea-8377-946f192c9773))+ 本 session 的 8 轮反向面试
- 分支:`cursor/knowledge-growth-plugin-72da`(orphan,与 main 无共同历史,不合并回 main)

---

## 一、已裁决(采访结论,不再重开)

| # | 问题 | 裁决 |
| --- | --- | --- |
| Q1 | 与 main 现存 harness 管道的关系 | **全新孵化,忘记 main**。main 的实证教训(钩子死循环、自觉流程衰减、句式路由)仅作设计输入,不作兼容约束 |
| Q2 | 产品形态 | **纯 skill 集合**,确定性小脚本内化在 skill 目录内(`scripts/`)。无独立引擎、无 MCP server、无生命周期钩子 |
| Q3 | 分发格式与首个平台 | **平台无关 SKILL.md 目录**;首个宿主平台 **Codex + Cursor**(一份目录双平台可达:Cursor 原生发现 skills,Codex 走 AGENTS.md 指针) |
| Q4 | 知识晋升审批 | **分级自治**:低风险类别自动 active;契约 / 机器约束 / 全局规则停 candidate 攒批人审 |
| Q5 | 消费端注入 | **发布即注入**:compiler(agent 角色)把知识编译进宿主原生载体 —— AGENTS.md 托管段、reference 文档、skill 草案、test/lint 提案。不建独立 retrieve 运行时 |
| Q6 | 管道节奏 | **轻重分离 + 快速通道**:采集轻(任务内嵌,允许 `no_change`);编译重(批处理专职会话);人工纠正即时单条编译 |
| Q7 | 第一个 dogfood 宿主 | **在 plugin 之上从零重建 Blue Apron 工程**——plugin 是新工程的第一块基石,新工程的 AGENTS.md 从第一天起就是编译产物 |
| Q8 | 分发意图与语言 | **预备对外的通用件**:skill 正文 / schema / 代码注释英文;对人的报告与交互输出跟随用户语言(中文) |

## 二、待裁决决策点(确认 RFC 时逐条表态,默认按推荐执行)

### D1 · 命名

**推荐**:plugin 名 `kg`(knowledge growth);skill 前缀 `kg-`;协议正式名 Project Knowledge Growth Protocol。
备选:全称目录名 `knowledge-growth`(更自述,但命令与前缀变长)。

### D2 · MVP 编译输出分类集

**推荐** 6 类(ChatGPT 方案 8 类裁剪):

```text
no_change               本次无值得沉淀的知识(合法且常见的结果)
needs_human_decision    证据冲突或重大未知,进裁决队列
project_knowledge       解释性知识(是什么/为什么)          → 自动 active
procedure               可重复操作/排查流程                → 自动 active
project_contract        稳定契约/架构边界/验收要求         → 人审
executable_constraint   应转化为 test/lint/type/CI 的约束  → 人审
```

裁剪理由:`task_context` 属任务系统而非知识系统;`engineering_change` MVP 期并入
`needs_human_decision`(都是「人来定」)。生命周期同步裁剪:去掉 `experimental`
状态——分级自治已承担灰度职责,MVP 不需要第二套灰度机制。

### D3 · 目录布局(plugin 本体 + 宿主侧)

**推荐**——plugin 本体(本分支根):

```text
skills/
  kg-init/SKILL.md      + scripts/   安装:生成宿主目录、植入 AGENTS.md 锚点
  kg-observe/SKILL.md   + scripts/   采集:落盘观察,schema 校验,阈值检查
  kg-compile/SKILL.md   + scripts/   编译:去重/碰撞/路由/发布/减法/裁决队列
protocol/
  observation.schema.yaml
  knowledge.schema.yaml
  lifecycle.yaml
  authority.yaml
  routing.yaml
docs/
README.md
```

宿主侧(`kg-init` 生成):

```text
.kg/                    管道状态(机器管理,人只读)
  config.yaml
  observations/         inbox,append-only
  queue/                needs_human_decision 裁决清单
  reports/              编译报告(含指标)
knowledge/              知识条目 = SoT(可见,git 追踪,frontmatter + 正文)
AGENTS.md               含 kg 托管段(锚点 + 由 active 条目渲染的索引/硬约束)
```

关键取舍:**知识条目本身就是发布物**(`knowledge/*.md` 即 reference 载体),
避免「YAML 源 + 渲染副本」双重维护;只有 AGENTS.md 托管段和 skill 草案是渲染产物,
由脚本从条目生成,禁止手改渲染段(改源重渲)。

### D4 · 人审裁决界面

**推荐**:git-native 队列文件。`kg-compile` 把待裁决项写入 `.kg/queue/`(每项含
claim、证据、选项、推荐),并在编译报告末尾输出裁决清单;人在任意 agent 会话里口头
裁决(agent 代为落盘)或直接编辑队列文件。不引入 PR 流程、不做交互式 CLI。

### D5 · 种子知识导入

**推荐**:做。把 main 分支已被实证的 harness 教训(生命周期钩子死循环、自觉流程
衰减必须闸门化、句式→载体路由、AGENTS 行数预算与减法纪律等)转写为第一批带证据的
知识条目,随 `kg-init` 一起进入新工程。这是内容复用,不是架构兼容——与 Q1 不冲突。
否决即全零启动。

### D6 · 成功指标(MVP 轻量版)

**推荐**:只追踪编译报告能免费产出的四个,不建独立度量设施:

```text
重复纠正计数     同一主题的人工纠正第二次出现 = 系统失效信号
候选接受率       人审队列中被接受 / 被否决的比例
knowledge regret 条目被降级/淘汰时必须记录原因(错误知识造成过什么)
减法比           每轮编译的 合并+降级+淘汰 数 / 新增数(防单调膨胀)
```

---

## 三、需求复述

一个运行在代码仓库内部、以 skill 集合形态存在的知识编译系统。它持续收集 agent
工作过程中的原始信号(人工纠正、任务结果、测试失败、review 意见),由一个
**compiler agent 角色**将其中可复用、可验证、有项目特异性的内容编译成结构化知识
条目,并按类别路由发布到宿主项目的原生载体——AGENTS.md 托管段、reference 文档、
skill 草案、test/lint 提案。发布即注入:宿主平台的原生发现机制(AGENTS.md 每
session 注入、skill description 常驻、reference 按需读)就是投递管道。

全自动优先;不能自动的环节(批量编译、高风险裁决)接受人工触发。知识不能只增不减:
生命周期状态机保证合并、降级、淘汰与「散文升级为机器约束后删除原文」。

**核心待验证假设**(孵化期唯一北极星):

> 经编译的项目知识,能否显著减少重复纠正、同类失败和无效上下文注入。

## 四、闭环

```text
工作 agent 执行任务
  ↓ kg-observe(轻:任务收尾时落盘观察;人工纠正走快速通道即时编译)
.kg/observations/ 积累;阈值提醒
  ↓ kg-compile(重:批处理会话 —— 去重、碰撞检测、跨任务模式识别)
六类输出 → 分级路由
  ├─ 自动 active:knowledge/ 条目(project_knowledge / procedure)
  ├─ 人审队列:.kg/queue/(project_contract / executable_constraint / AGENTS 段 / skill 创建)
  └─ no_change:只记报告
  ↓ 发布(渲染 AGENTS.md 托管段;起草 skill;生成 test/lint 提案)
后续任务经宿主原生机制消费知识
  ↓ 结果回流(知识被引用却仍出错 → conflicted;降级/淘汰记 regret)
```

## 五、六个协议(实现的固定接口,`protocol/` 落盘)

### 5.1 Observation Schema

采集端唯一入口格式。示例(英文字段,实现时以 schema 文件为准):

```yaml
id: OBS-20260712-001
at: 2026-07-12T07:30:00Z
source: human_correction   # human_correction | task_outcome | test_failure | review | agent_insight
claim: One-shot URL params must be consumed by a single coordinator.
context:
  task: <free text or task id>
  paths: [src/app/menu/**]
evidence:
  - type: diff | test | log | quote
    ref: <path / excerpt>
urgency: fast_track | batch   # human_correction defaults to fast_track
```

### 5.2 Knowledge Entry Schema

`knowledge/*.md` 的 frontmatter(条目即发布物):

```yaml
id: KN-00031
claim: <one-sentence normative statement>
category: project_knowledge | procedure | project_contract | executable_constraint
scope: { paths: [...], domains: [...] }
evidence: [{ type, ref }]
authority: <level, see 5.3>
confidence: 0.0-1.0
lifecycle: candidate | active | deprecated | archived | rejected | conflicted
supersedes: <id | null>
last_verified: <date>
regret: <null | reason recorded on demotion>
```

### 5.3 Authority Model(冲突裁决顺序,高压低)

```text
user_explicit_constraint > verified_runtime_behavior > machine_constraint(test/type/CI)
> current_code_and_schema > formal_decision > project_knowledge
> past_task_conclusion > agent_inference > external_general_knowledge
```

冲突时禁止静默选边:输出冲突报告进裁决队列。权威级决定默认行动,不代表绝对真理
(代码可能有 bug,测试可能固化错误行为)。

### 5.4 Lifecycle State Machine

```text
observation → candidate → active → deprecated → archived
                  ├→ rejected
                  └→ conflicted(证据冲突时,由任一状态进入)
```

迁移合法性由 `kg-compile` 内嵌脚本机器校验(违反即失败)。MVP 无 `experimental`
(见 D2)。降级/淘汰必须填 `regret` 字段。

### 5.5 Compiler Output Contract

输入:观察批次 + 现有知识全集。输出:每条观察映射到 D2 六类之一,并产出:

```text
路由动作     add / update / merge / demote / retire + destination
减法义务     每轮编译必须显式回答「本轮淘汰/合并了什么」(可为空,但必须回答)
编译报告     .kg/reports/ —— 含 D6 四指标与裁决清单
```

发布载体路由表:

| 类别 | 载体 | 自治级 |
| --- | --- | --- |
| project_knowledge | `knowledge/*.md` + AGENTS References 索引行 | 自动 |
| procedure | `knowledge/*.md`;成熟后提案升级为独立 skill | 条目自动;skill 化人审 |
| project_contract | AGENTS.md 托管段 / scoped rule | 人审 |
| executable_constraint | test / lint / type / CI 提案 | 人审 |
| needs_human_decision | `.kg/queue/` | 人 |

### 5.6 Host Integration Protocol

- 安装 = `kg-init`:生成 `.kg/` 与 `knowledge/`,在宿主 AGENTS.md 植入**托管段**
  (HTML 注释锚点包裹,3-5 行常驻入口 + 索引;段内容器脚本渲染,行数预算脚本强制);
- 平台发现:Cursor 经 `.agents/skills/`(symlink 或复制),Codex 经 AGENTS.md 锚点
  指令;新平台 = 新发现路径,零逻辑改动;
- 所有知识变更都是 git diff:版本、review、回滚、归责全部复用 git。

## 六、MVP 范围

**做**:三个 skill(`kg-init` / `kg-observe` / `kg-compile`)+ 五个协议文件 +
内嵌脚本(schema 校验、生命周期迁移校验、AGENTS 托管段渲染与预算检查、观察阈值
提醒)+ 种子知识(D5)。

**不做**(显式推迟):向量检索、MCP server、生命周期钩子、Claude Code plugin 壳、
多仓库共享知识、自动修改宿主既有规则、多 agent 评审委员会、独立度量设施。

## 七、Tasks

| # | 任务 | 产出 | 状态 |
| --- | --- | --- | --- |
| T1 | 协议层 | `protocol/` 五文件 + 校验脚本骨架 | pending |
| T2 | kg-observe | SKILL.md + 落盘/校验/阈值脚本 | pending |
| T3 | kg-compile | SKILL.md + 路由/渲染/减法/报告脚本 | pending |
| T4 | kg-init | SKILL.md + 宿主生成/锚点植入脚本 | pending |
| T5 | 种子知识 | main 教训 → 初始 `knowledge/` 条目 | pending |
| T6 | 自举演练 | 用本 plugin 的开发过程跑一轮完整闭环,修接口毛刺 | pending |

顺序:T1 定接口,T2-T4 依赖 T1;T5/T6 收尾。每个 task 一个 commit 系列,T6 前
plugin 必须能在空目录上完成 init → observe → compile → publish 全链路。

## 八、开源竞品扫描(2026-07,详见采访记录)

三个流派,无一与本设计完全重合:

| 流派 | 代表 | 核心机制 | 与 kg 的差距 |
| --- | --- | --- | --- |
| 工作流沉淀 | [compound-engineering-plugin](https://github.com/EveryInc/compound-engineering-plugin)(Every,~7k stars)、self-improving-agent、claude-reflect-system | 任务收尾把学习写回 CLAUDE.md / rules / skill | 绑定 Claude Code(plugin/钩子/slash commands);无生命周期、权威模型、减法纪律 |
| 知识编译引擎 | [agent-knowledge](https://github.com/yucx-go/agent-knowledge)(compiled-memory) | Claim + Evidence → Compiled Truth,矛盾检测——唯一同用「编译器」心智模型的项目 | MCP server + 检索运行时;知识住数据库而非 git,不路由原生载体 |
| 通用记忆基建 | mem0(~47k stars)、Letta、Zep、Cognee、claude-mem、OpenLTM | DB + 向量/图检索 + session 注入 | 解决「回忆」不解决「治理」;无人审分级、不随代码走 git review |

kg 的差异化空位 = 五属性同时成立:发布即注入原生载体、git-native 治理、
分级自治 + 生命周期 + regret/减法、零引擎零钩子纯 skill 形态、散文→机器约束升级
路径。定位风险:「compound engineering」已是流派名词,对外话术须主动区分
「工作流插件」vs「知识编译协议」。`kg` 名称当前无冲突。

## 九、风险与开放问题

- **自觉衰减**:无钩子平台上,采集依赖 skill description 触发——AGENTS 锚点里的
  一行采集提示是唯一兜底;若 dogfood 显示遗漏率高,升级路径是 Claude Code plugin
  壳的确定性钩子(fail-open、幂等、一键停用——main 的死循环教训)。
- **编译质量随会话模型波动**:compiler 是 agent 角色,无固定模型;协议 schema 和
  机器校验是质量下限,上限不承诺。
- **上下文膨胀**:托管段预算 + 减法义务 + regret 追踪三重防线;若仍膨胀,说明
  路由表需要收紧(更多内容判 no_change)。
- **单一宿主过拟合**:MVP 只在重建的 Blue Apron 工程 dogfood;通用性主张要等第二个
  宿主才有证据。
