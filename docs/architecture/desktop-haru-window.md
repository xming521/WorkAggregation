# Haru 独立桌面小窗

状态：实验分支本地实现；2026-10-08。源码与 mock 回归已覆盖，不等同于 Windows 安装包或真实窗口验收。没有开机启动、系统设置改动或 Win+D 桌面层保证。

## 窗口与退出

- 主窗口继续持有唯一 `AssistantSurfaceProvider`、Pilot controller、请求租约、审批与恢复状态。主窗最小化或关闭收托盘，不卸载 owner；关闭 Haru 只隐藏小窗，不中止任务。
- Haru 是透明、无边框、独立 BrowserWindow。标题栏拖动，提供展开/收起、显隐、可选置顶及打开主窗。托盘可重新打开两个窗口；“退出并停止本地服务”走原有有界后端关闭流程。
- 系统托盘创建失败时，主窗关闭直接退出，避免无入口的后台进程。owner renderer 崩溃仍按原致命错误路径退出；Haru renderer 崩溃可从托盘重建，不能恢复或重放请求。
- 位置与置顶偏好只写应用 userData 内 `haru-window.json`；恢复、展开与屏幕移除/缩放变化时按真实 display workArea 限位，支持负坐标屏幕。默认不置顶。
- Haru 隐藏后释放 Live2D ticker，恢复后读取最新镜像；空闲采用静态单帧。主窗内现有 mascot 在 document 隐藏时释放 runtime。小窗入口分块加载，不创建第二份 AppShell 或业务服务。

## 身份与通信边界

主窗保留原持久 session。Haru 使用独立、非持久 partition，不共享 localStorage、IndexedDB、cookie 或 BroadcastChannel。两者均 sandbox、context isolation、禁用 Node integration；Haru 禁止所有权限与下载。

桌面随机 token 只留主进程。每次请求先剥离调用方伪造的 token：主 session 只向仍存活的可信 owner webContents 的精确本地 origin 注入；Haru session 只允许 GET/HEAD 的显式静态 assets/live2d 路径及固定顶层入口，拒绝 API、编码路径、额外 query、子 frame 与远程请求。Haru 同时采用 onBeforeRequest 白名单及 header 注入白名单。

preload 不暴露通用 IPC、文件、shell、token 或审批 API。每次 IPC 都校验当前窗口对象、顶层 frame 及精确 origin。owner 仅发布有界最近消息文本、上下文标签、运行/停止/待审批标志；不复制 pending action、工具参数、provider 配置或确认凭据。

小窗仅转发发送、停止、打开待审批页面。审批在原 Pilot 工作区完成。每条命令携带 owner generation 与控制状态 version；owner-only 签名覆盖真实上下文身份、附件、draftContext、执行身份与选择过程，签名不传出窗口。流式文字变化不改变控制 version，避免阻止正常 Stop。owner 重载/失联会使镜像失效并禁用操作。

main 只容许一条待 ACK IPC；owner 命令 ID 去重、同步核对实时 refs，并复用 controller 的唯一 request lease。发送只在取得 lease 后 ACK；被 ignored 的发送不能被标为成功。超时/连接丢失不自动重试，小窗保留输入并要求用户到主窗核对。Haru 输入不会覆盖主窗已有未发送草稿。

## 中英文界面与独立窗口同步

桌面语言适配基于产品提交 `9c245314e570f1d6de034e4d52deb46979874416`，在独立 `feat/20261015-desktop-localization` 分支施工；不修改原有桌面分支，不并入其后续安装验证辅助提交，也不合并到 master 或发布安装包。网页通用语言层在独立分支整合，原生层不复制其无关功能。

主进程将语言单独保存在 userData 的 `desktop-locale.json`，仅接受 `zh-CN` / `en-US`。首次启动、损坏或非法偏好回退中文；显式选择会原子重写有效偏好。写入失败保持原值并返回安全错误，不能把失败当持久化成功。更新离线备份同时保留此偏好。

`offerpilotLocale` 是有限 IPC：可信 owner 主 frame 可读取、订阅和保存；Haru 只能读取和订阅。主进程复用 exact webContents / mainFrame / origin 校验，广播只发送到当前可信窗口；重建 Haru 可重新读取最新值。两窗口继续使用独立 partition，不依赖 localStorage、cookie 或 BroadcastChannel 共享。新增接口不暴露任意路径、通用 IPC、令牌或业务写操作。

原生菜单、托盘、导出/权限/外链对话框、启动错误及更新安装确认使用主进程当前语言。更新状态的固定提示在 renderer 显示时翻译；更新说明、用户输入、对话内容、自定义上下文及模型/角色素材保留原文。中文与英文均保留默认取消、安装前状态复核和明确退出服务的含义。Haru 自有的发送失败以单一白名单展示键保留来源，在显示时按当前语言翻译；其他错误文本原样显示，不根据内容猜测来源。

renderer 适配器 `web/src/i18n/desktopLocale.ts` 在读取前订阅变更、拒绝非法值并忽略过期启动回复。入口在挂载主窗或 Haru 前等待桌面权威值；桌面桥缺失/读取失败时显示可重试错误，不静默使用 localStorage。设置变更等待持久化成功，界面在写入期间禁用重复选择；事件版本与请求序号保护过期 setter 回复，事件只应用偏好而不回写。此适配器本身不创建第二个业务 owner，也不重挂载工作区或清空草稿。

## 验证与限制

相关入口：

- `node --test desktop/test/*.test.cjs`：包括 DTO 白名单、非法命令、frame/origin、双 session token 边界、reload epoch、并发/失联不重放、托盘关闭、隐藏广播节流和多屏限位。
- `npm --prefix web test -- src/features/assistantSurface src/features/pilotMascot`：包括小窗交互、相同名称不同目标/附件变化、流式 Stop、执行身份变化、render 前选择锁、ignored send、主窗草稿保护与隐藏动画释放。
- `npm --prefix web run build`：TypeScript 与生产构建。

本地 Chromium mock 截图启动被宿主 socket 权限阻止；云浏览器与当前工作区不共享 localhost，访问 mock 端口被拒绝。因此本次没有真实浏览器截图或 Windows 原生窗口结果，也未调用真实模型、读取配置密钥、生成安装包或推送远端。

安装包验收还需在 Windows 证明：透明/拖动/多 DPI 屏幕限位、主窗关闭后 Haru 连续请求及停止、审批仅从主窗执行、托盘恢复与明确退出清理、真实 session 存储隔离、隐藏/空闲 CPU 与动画暂停。应在最新整合代码上重新打包与固定 provenance，不可沿用旧安装包的 UI 通过结论。

相关：[桌面验证说明](desktop-validation.md)、[固定安装包 UI 验证](desktop-installed-ui-validation.md)、[仓库验收规则](../../AGENTS.md#7-验证与-code-review)。

## 2026-10-15 本地化隔离集成来源

集成分支 `feat/20261015-desktop-localization` 从产品快照 `9c245314e570f1d6de034e4d52deb46979874416` 开始，增加原生语言提交 `aa444dd0` 与来源明确的错误展示修复 `5d9c95a`，再整合已接受 master `54d7f26b`（包含邮件助手）及网页本地化树 `175f17af`。原桌面验证分支、已固定安装器、之后的实验 helper 提交均未修改或纳入此集成来源。

冲突合并同时保留桌面 transport 身份验证与邮件 Origin 围栏；可信桌面 transport 不得绕过邮件 Origin 检查。专用本地 TestClient 回归覆盖两者组合。主窗、Haru、菜单的语言同步通过有限 IPC，切换不触发业务调用或确认重放。页面上下文构建器用本地 WeakMap 标记自有展示字段，控制签名只规范化仍未变更的自有文字；不加入传输字段，不根据普通文本推断来源，用户自定义标签、ID、筛选、附件、草稿与执行语义仍参与版本判定。网页远端提交为 `f6c19f1af386f65bdfdecbbe28003b43aaf2561a`，与本地 `175f17af` 的完整树 `4eac7cb27fc24e7d136cc05ab80ebb8e2ed88da1` 完全一致。此新树必须独立构建、截图和验收，旧 `9c245314` 的测试或安装包记录不能作为该集成已通过的证明。
