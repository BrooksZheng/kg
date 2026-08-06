## 硬规则

- 禁止读取 `.kg/`：这里存放未经编译的 claim 与管道状态；写入只经 `kg-observe`，读取只发生在 `kg-compile` 会话。

## Commands

```bash
# 构建（无构建步骤：零依赖 Node ESM，脚本直接运行）
# 测试（七个 part 全绿才算通过）
node scripts/test-v2.mjs
# lint（无 linter；改为校验 skills/ 下 vendored 的 lib/ 与 protocol/ 无漂移）
node scripts/sync-vendored.mjs --check
```

## 使用 kg

- `kg-kickoff`：任务开始时逐项澄清约束。
- `kg-spec`：共识形成后固化 task spec。
- `kg-observe`：任务中记录可复用信号。
