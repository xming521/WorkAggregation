# 原创角色接入验证

状态：独立验证分支，依赖桌面集成 PR #36；不是正式角色替换或发布验收。

## 使用与范围

设置 → Haru →「原创角色接入验证」开启后，网页角色与桌面小窗切换到原创预览。
默认仍为旧角色，关闭开关即可返回。桌面由主窗口把限定角色值传给隔离小窗；
不共享 session，不新增小窗的后端访问或命令权限。用户尚未选择新名称，既有名称与协议保持。

原创预览只使用已确认的四秒循环：轻微呼吸、外围发丝微动，以及三态眨眼。
现有任务状态、点击打开对话、收起、拖动、置顶、主窗口跳转、AI 配置和写入确认逻辑不变。
对话模式使用静态上半身构图和同源头像；独立人物模式等比显示完整人物，不裁发梢或鞋底。
它不是完整分层骨骼角色，没有新增表情、口型、挥手或其他交互动作。

已有可供后续动作设计参考的状态（本分支不新增其表现）：
idle、thinking、preparing_voice、speaking、waiting_for_speech、listening、
speech_paused、transcribing、reviewing_voice、waiting_confirmation、success、error。

## 渲染与降级

- 官方 @rive-app/canvas 2.44.2 固定版本；JS、WASM、PNG、Rive 文件均打入本地资源。
- 禁用 WASM CDN fallback 与 Rive asset CDN；角色的三张来源图已内嵌于 Rive 文件。
- Canvas runtime 的图片网格仍需离屏 WebGL2。加载成功不等于绘制成功，需检查实际 alpha 像素。
- 关闭动画或系统减少动态时直接使用 PNG，不启动 WASM 或动画 ticker。
- 加载/图形失败、超时、可见画布丢失上下文，或连续两次离屏网格像素消失时切静态 PNG。
- 两秒一次健康检查；隐藏/零尺寸不判为故障；卸载清理 player、监听、observer、定时器和节点。
- 旧角色与原创角色切换创建新 canvas，避免 WebGL 与 2D 上下文类型冲突。
- 没有添加 Chrome/Electron 安全绕过参数；桌面 sandbox、CSP 和资源白名单保持原样。

## 资产与验证边界

资产出处见 web/public/mascot/PROVENANCE.txt；运行时 MIT 通知随包放在
web/public/assets/mascot/RIVE-LICENSE.txt。MIT 不被错误套用到角色原画。

焦点单测覆盖选择、快照边界、静态/异常降级、重复挂载、清理与旧交互。
浏览器像素/截图验证使用真实产品组件和限定假桥接，不调用模型或后端。
浏览器组件证据不等于 Windows 原生安装包、透明窗口合成、托盘或系统 DPI 验收。
本分支没有合并 master、替换 PR #36 或发布 Release；正式替换及新增动作需另行确认。
