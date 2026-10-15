# 原包 Windows 本地化验收重试

首次新包 run [38710428545](https://github.com/offercontext/offerPilot/actions/runs/38710428545) 的原生 89 项、harness 10 项、renderer 106 项、Python 128 项、ruff/mypy、生产构建、冻结及两次进程 smoke、NSIS 与 SHA256 均通过；已实际安装并确认 payload 与同构建目录一致。首次 UI 验收在 `launch-1` assertion 失败，尚无语言切换、重启或截图验收通过记录。原报告未保留更细的失败断言，不能据此断定是产品或测试驱动问题。

原包固定来源 `05fcd54a3bc0f3ebd792083704c6a5a861099797`，tree `9b1511d567132d5fcf4c0ef69100390095cf41fe`：

- [installer artifact 11961578103](https://github.com/offercontext/offerPilot/actions/runs/38710428545/artifacts/11961578103)，ZIP SHA256 `c26146dd15807c18e973f4eef88c91d2d12f34526bc417602f0bf2453f2f5ced`。
- installer `OfferPilot-Desktop-localization-05fcd54a3bc0-win-x64-setup.exe`，SHA256 `614acdc2e4eae82c97ca0c699038a83ef89db7d0a32f5f269e64d4619e20d520`。
- [原始 evidence artifact 11961468467](https://github.com/offercontext/offerPilot/actions/runs/38710428545/artifacts/11961468467)，ZIP SHA256 `938b56ff547d9571e3dd692e9aef32db19d9ad67c005a5f789dc57c209ade3a4`。

新的 [desktop-localization-retry.yml](../../.github/workflows/desktop-localization-retry.yml) 只在同一功能分支的该工作流或 `desktop/localization-ui/**` 变化时 push 激活，另提供受平台注册限制的 dispatch。它不运行产品编译、Python 安装/冻结、Vite、NSIS 或旧 helper，不修改/替换原 artifact，也不把原 run 改为成功。只需要只读 `contents/actions` 权限，无自动取消。

重试先验证原 run、attempt、source、前置成功步骤与 artifact ID/name/digest，再按精确 ID 下载原 ZIP，逐个比对 ZIP SHA256 后解压；installer SHA256 与原接受状态 manifest 必须一致，缺少原 source/installed-web/installed-backend/result JSON 即失败。新 harness revision 与只读原产品 checkout 分开记录；原锁文件必须相同，仅 `npm ci --ignore-scripts` 提供 Playwright/ASAR 检查依赖。

显式 `LOCALIZATION_RETRY_ORIGINAL=1` 模式使用原证据中的安装文件/树清单和原源码核对安装 payload，不能用重新构建的 `win-unpacked` 或 `web/dist` 替代原证据。新报告记录修订后的 harness SHA 与固定产品 SHA；更细诊断不能删除安全/语言断言。重试证据在成功或失败时均上传为 `windows-localization-same-package-05fcd54a3bc0-<harness SHA>-<run>-<attempt>`，原包继续留在原 artifact。重试实际结果须另查对应 run，不将入口存在当作通过。
