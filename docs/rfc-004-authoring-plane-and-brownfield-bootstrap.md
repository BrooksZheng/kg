---
kind: kg.project_document
title: "RFC-004: Authoring Plane and Brownfield Bootstrap"
doc_type: rfc
status: accepted
owners: [brooks]
accepted_at: 2026-07-24
supersedes: null
source_refs: [docs/rfc-001-project-knowledge-growth-protocol.md, docs/rfc-002-agents-md-compiled-artifact.md]
---

# RFC-004 · 文档创作平面与 Brownfield Bootstrap

- 状态：**confirmed**
- 人工裁决：2026-07-24，「都按你的推荐做一个版本吧」
- 关系：扩展 RFC-001 与 RFC-002
- 迁移：RFC-001 D5 对 greenfield 继续有效；brownfield 由本文接管

## 一、问题

RFC-001 将 Observation 定义为采集端唯一入口，并将 Knowledge Entry
定义为发布载体。这个边界适合任务过程中的经验沉淀，却没有覆盖人与 Agent
共同起草完整 ADR、RFC、MVP 技术方案和项目文档的协作过程。

缺少显式文档创作边界时，Agent 容易把 Knowledge Entry 的原子性要求扩展到
所有 Markdown 文档，进而拒绝直接写完整方案。对于已有代码的项目，原有
greenfield 零知识启动假设还会使 KG 无法建立初始项目地图。

本文增加两个能力：

1. Authoring Plane：允许完整项目文档直接创作、讨论和修订。
2. Brownfield Bootstrap：从现有代码生成带证据的文档草稿。

## 二、裁决

| # | 裁决 |
| --- | --- |
| A1 | 完整 ADR、RFC、技术方案与项目文档可以直接创建和修改。KG 管道不得成为文档创作的前置门槛 |
| A2 | 文档模板、目录约定和生命周期保持相对稳定；文档正文持续演进 |
| A3 | `kg-init` 在人工显式触发的 Setup 中进行简短 Interview，并提供 lean、standard、none 三种文档 Profile |
| A4 | Brownfield 扫描由独立 `kg-scan` Skill 执行；Setup 负责识别场景并提供入口 |
| A5 | `kg-scan` 默认只做静态读取，不执行项目代码，不读取 `.kg/` |
| A6 | 扫描结果先生成 draft 文档；已存在的项目文档不被静默覆盖 |
| A7 | 项目文档生命周期为 draft、proposed、accepted、rejected、superseded |
| A8 | 只有 accepted 且显式声明 `kind: kg.project_document` 的文档成为 Compile 输入 |
| A9 | ADR/RFC 保存完整叙事、讨论历史和理由；KN 条目保存原子 claim、治理元数据和原文指针 |
| A10 | Observer 继续采集持续学习信号；Scan 建立初始基线；两者在 Compile 汇合 |

## 三、整体架构

```text
Authoring Plane
  人与 Agent 直接起草完整文档
  docs/architecture · docs/decisions · docs/rfcs · docs/glossary.md
        │
        ├─ draft / proposed：继续协作，不进入 Compile
        └─ accepted：成为 formal decision source
                         │
Brownfield Bootstrap    │        Continuous Learning
  kg-scan               │          kg-observe
  代码事实与推断草稿      │          任务过程信号
        └───────────────┴──────────────┐
                                       ↓
                               Governed Compile
                         authority · lifecycle · queue
                                       ↓
                                Atomic KN ledger
                                       ↓
                              Harness publication
                         AGENTS.md · Skill · test · CI
```

现有 Ledger Layer 与 Render Layer 的稳定性承诺保持不变。Authoring Plane
和 Scan Adapter 位于 Ledger 输入侧。

## 四、项目文档契约

### 4.1 普通文档

任何 Markdown 文档都可以自由创建。没有 KG frontmatter 的文档属于普通项目
文档，Compile 不会自动读取它。

### 4.2 注册文档

需要进入 Compile 的文档使用如下 frontmatter：

```yaml
---
kind: kg.project_document
title: "Choose PostgreSQL for transactional storage"
doc_type: decision
status: accepted
owners: [platform-team]
accepted_at: 2026-07-24
supersedes: null
source_refs: [src/storage/index.ts]
---
```

字段定义以 `protocol/project-document.schema.yaml` 为准。

### 4.3 生命周期

```text
draft → proposed → accepted → superseded
          └──────→ rejected
```

- Agent 可以自由创建和修改 draft。
- Agent 可以按用户要求提交 proposed。
- Agent 只有在用户明确接受后才能写入 accepted 与 `accepted_at`。
- accepted 文档发生实质变更时，应回到 proposed 或新建替代文档。
- 新文档通过 `supersedes` 指向被替代来源。
- superseded 文档保留 `accepted_at` 历史，并通过 `superseded_by` 指向替代来源。

### 4.4 Source of Truth

- accepted ADR/RFC 是决策叙事与理由的权威来源。
- KN 条目引用源文档路径与章节，不复制完整叙事。
- 没有自然文档归属的持续学习结果可以继续以 KN 条目作为权威来源。
- 代码事实与 accepted 文档冲突时必须进入裁决，禁止静默覆盖。

## 五、Setup Interview

`kg-init` 保持人工显式触发。Skill 在首次安装前询问两个核心问题：

1. 项目阶段：greenfield 或 brownfield。
2. 文档 Profile：lean、standard 或 none。

用户已经提供答案时直接执行，避免重复提问。

### 5.1 Profile

| Profile | 创建内容 |
| --- | --- |
| lean | `docs/README.md`、architecture overview、decision log 与模板、glossary |
| standard | lean 全部内容，加 RFC 目录与模板、standards、development |
| none | 不创建文档模板，只安装 KG 管道 |

模板只在目标文件缺失时创建。现有文件始终保留。

### 5.2 Brownfield 入口

Setup 选择 brownfield 后，安装器输出明确的下一步提示，由 Agent 在安装完成后
进入 `kg-scan` 会话。安装脚本自身不执行语义扫描。

## 六、kg-scan

### 6.1 扫描范围

第一版覆盖：

- 技术栈与项目清单
- 构建、测试和常用开发命令
- HTTP API、CLI、公开模块、Schema 与事件线索
- 模块边界和目录依赖线索
- 领域术语候选
- 已有 ADR、RFC、规范和 Runbook
- 代码与文档之间的冲突
- 需要用户回答的未知项

### 6.2 两阶段执行

阶段一是确定性 Inventory：

- 使用 `scripts/scan-inventory.mjs`
- 只读取安全文本文件
- 排除 `.kg/`、Git 元数据、依赖、构建产物、生成目录和敏感文件
- 输出语言、manifest、命令、API 路径、公开符号和现有文档线索

阶段二是 Agent 语义 Shape：

- 读取阶段一给出的有限证据路径
- 将内容区分为 observed fact、inference、conflict、unknown
- 每项保留文件路径和行号
- 生成项目文档草稿或补丁提案

### 6.3 输出

建议输出：

```text
docs/inventory/SCAN-YYYYMMDD.md
docs/architecture/overview.md
docs/api/README.md
docs/glossary.md
docs/proposals/SCAN-YYYYMMDD-*.md
```

目标文件缺失时可以直接创建 draft。目标文件已有内容时，扫描结果进入
`docs/proposals/`，由人审决定如何合并。

### 6.4 权威映射

| 内容 | Authority |
| --- | --- |
| 文件、路由、Schema、manifest 中直接观察到的事实 | `current_code_and_schema` |
| 执行并复现的运行行为 | `verified_runtime_behavior` |
| Agent 对术语、职责和边界的解释 | `agent_inference` |
| 用户确认后的项目文档 | `formal_decision` 或 `user_explicit_constraint` |

## 七、安全与规模边界

- 默认禁止执行项目脚本、构建、测试、迁移或网络请求。
- 运行时验证需要用户授权，并与静态扫描结果分开记录。
- 排除 `.env*`、密钥、证书、凭据、私钥、数据库和二进制文件。
- 不跟随符号链接。
- 大仓库使用文件数量、文件大小和命中数量预算。
- 扫描截断必须在报告中显式说明。
- `.kg/` 永久排除。

## 八、Compile 变化

Compile 输入从：

```text
pending observations + existing knowledge
```

扩展为：

```text
accepted project documents + pending observations + existing knowledge
```

处理顺序：

1. 验证注册文档。
2. 读取 accepted 文档。
3. 提取原子 claim，并保留源路径与章节。
4. 与 observation 和现有 KN 做去重、冲突检测和 authority 比较。
5. 继续使用现有分类、候选队列、生命周期和 Render。

同一 accepted 文档可以产生多个 KN 条目。每个条目继续保持一个 claim。

## 九、实施切片

| Slice | 内容 |
| --- | --- |
| S1 | RFC-004、project document schema、文档验证器 |
| S2 | kg-init Interview、Profile 模板、幂等创建 |
| S3 | kg-scan Skill、静态 Inventory 脚本、Shape 工作流 |
| S4 | kg-compile 接入 accepted 文档 |
| S5 | 分发同步、black-box 安装测试、自身 brownfield 扫描 |

## 十、验收

- Agent 可以直接起草完整 ADR/RFC，无需先写 observation。
- lean 与 standard Profile 在空宿主生成预期文件。
- 重跑 kg-init 不覆盖任何已有文档。
- brownfield Setup 明确引导进入 kg-scan。
- kg-scan 静态执行期间不读取 `.kg/`，不执行宿主代码。
- 扫描结果包含 API、架构、术语和已有文档四类证据。
- 普通 Markdown 不受 schema 约束。
- draft 与 proposed 文档不进入 Compile。
- accepted 注册文档可以被验证并作为 Compile 来源。
- registry、copy、symlink 三种安装模式继续保留自包含布局。

## 十一、非目标

- 通用多语言 AST 引擎
- 自动接受扫描结论
- 自动覆盖现有 ADR/RFC
- 自动执行构建与测试
- 向量数据库或独立检索服务
- 一次扫描生成完整且永久正确的架构模型

## 十二、社区设计依据

- arc42 提供目标、约束、上下文、架构视图、决策、质量、风险和术语表的
  可裁剪文档结构。
- MADR 将单个决策组织为状态、上下文、选项、结果与后果。
- Kubernetes KEP 展示了完整提案在批准前持续协作的生命周期。
- Diátaxis 说明不同目的的文档需要分开组织。
