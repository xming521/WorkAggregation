# 精简分支的一次性 AI 验收工具

本目录不是产品 provider，也不是通用付费测试框架。真实调用只允许在固定的
Ubuntu GitHub job、精确 H/R SHA、独立 Environment 人工审批和完整历史预检全部
通过后发生。当前准备与离线测试不代表获得运行许可，也不保证 10 元覆盖所有阶段。

## 平台与测试范围

- 账本依赖 Linux 的真实目录 `fsync`、文件 `fsync`、`pread` 与文件身份检查。
  非 Linux 平台在读取 secret、创建账本或网络调用之前明确拒绝，不模拟这些保证。
- 本目录 `tests/` 保留原来新增的全部 **203** 个离线案例。`offline-nodes.json`
  冻结逐节点列表，`offline.py` 在执行前核对完整 collection，再核对每个节点的
  setup、call、teardown 必须各一次且全部 passed。缺失、多出、重复、skip、xfail、
  collection 错误或非零退出均失败。没有为了兼容 Windows 而跳过耐久性测试。
- 仓库默认 `pytest` 的 `testpaths = ["tests"]` 继续覆盖 Windows 产品测试。
  迁移只移动本次新增的四个 helper 测试文件，不移动或删除原有产品节点。
  `tests/test_simplification_ai_platform.py` 是默认套件的新跨平台增量，验证早期拒绝、
  精确节点聚合和两个 CI 的强制连线。既有 shard 测试仅同步新增 job 依赖断言。
- cc6ba0f9 基线的 7347 个生产节点与此处 203 个 Linux helper 节点是两套范围，
  不能把“7347 全后端”描述成已包含这 203 个测试。最终生产 manifest 需按节点比较
  保留基线全集，再单独披露新增 platform 节点与实际 skip。
  本次 Linux collection 为 **7386**：7347 基线 + 36 平台契约 + 3 节点长度契约。
  其中 6 个 128 KiB 模型输出用例仅改为显式 `oversized-json` ID，输入和断言不变；
  Windows 的 `AF_INET6` 枚举参数 ID 为 23，Linux 为 10，此一对按相同用例映射。
  shard collector 对所有节点强制执行 32700 UTF-16 code unit 上限，超长即失败，
  不截断、跳过或删除测试；最终 Windows 实收与执行仍需同冻结 tree 的 CI 证明。
  Linux helper 的一个 200 KiB 非法 JSON 参数同样只改 `oversized-body` ID；
  默认平台契约对其全部 203 个清单 ID 复用同一长度检查，防止未来出现巨型日志。
- `desktop-windows.yml` 同一 SHA 的完整发布门禁同时要求 Windows 生产 shards 和
  Ubuntu helper-safety job 成功。后者缺失、失败、取消或 skipped 时，完整发布门禁失败。
  独立 `simplification-real-ai.yml` 的 offline job 使用同一命令，失败阻断 paid。

## 免费验证命令

从仓库根目录，在 Linux 运行：

```sh
uv sync --frozen
uv run --frozen python -m scripts.simplification_ai_validation.offline --output artifacts/simplification-offline/results.json
uv run --frozen pytest -q tests/test_simplification_ai_platform.py
uv run --frozen ruff check scripts/simplification_ai_validation tests/test_simplification_ai_platform.py
uv run --frozen mypy scripts/simplification_ai_validation --exclude /tests/ --follow-imports=silent --explicit-package-bases
```

203 个案例只使用 fake upstream，包括真实 CLI/loopback API 的 12 次正常调用和
最多 18 次 HTTP 的结构修复路径；不是直调模型冒充产品验收。输出包含逐节点状态，
不包含真实 secret、用户配置、prompt 或 response。不要设置 provider secret 来运行它。

## 支付边界

每个实际 HTTP 在发送前先持久化预留 3 元，总额 10 元，最多 18 次，并发 1。
可信 usage 按所有输入 token 的峰值 cache-miss 价格结算；结果不明或账本异常保留
预留并停止。禁止 fallback、自动 retry、redirect、复用旧运行消费或新建账本重置预算。
当前价格依据、固定模型/端点、90 秒请求窗口、20 分钟 session 及报价截止均在
`broker.py` 中显式冻结；到期必须阻断，不能用重跑自动延长。

不读取旧 secret、旧 paid 脚本配置或旧账本。这个工具不承诺 Windows 付费支持。
