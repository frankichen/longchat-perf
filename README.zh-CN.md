# LongChat Perf · 任务生命监视器

这是一个面向 **ChatGPT Web 长会话/长任务** 的 Chromium 扩展，整合两类能力：

1. **长会话性能优化**：屏外渲染跳过、旧消息渐进折叠、流式输出防抖、CodeMirror 代码块批量挂载、主线程长任务统计。
2. **任务生命体征与请求保护**：降低会话列表/详情重复请求与 429，观测 `stream_status` / `resume`，区分“仍在运行 / 断流 / 已结束 / 已结束但最终回复未落盘”，并可选联动 DevHub。

当前版本：**v0.5.2**。界面与状态提示全部使用中文。生命体征详情面板打开后，点击页面其他位置会自动收起。

## 直接下载 ZIP

GitHub Release 会附带：

- `longchat-perf-v0.5.2.zip`：扩展压缩包；
- `longchat-perf-v0.5.2.zip.sha256`：SHA-256 校验文件。

解压 ZIP 后，在 `edge://extensions/` 或 `chrome://extensions/` 开启开发者模式，选择“加载已解压的扩展程序”，加载解压后的目录。

每次发布 Release，`.github/workflows/package-extension.yml` 会自动运行测试、生成 ZIP 并上传为 Release Asset；手工运行该 workflow 也会产生 GitHub Actions Artifact。

## 长会话性能优化

保留原 LongChat Perf 的五项补丁：

- **屏外渲染跳过**：使用 `content-visibility: auto`，含表格消息自动排除，避免宽表格裁剪。
- **中和毛玻璃**：可选关闭 `backdrop-filter`，减少合成开销。
- **旧消息渐进折叠**：仅在用户向下滚动时折叠远离视口的早期消息，向上滚动立即展开。
- **流式输出防抖**：输出期间暂停消息区动画和过渡。
- **CodeMirror 批量挂载**：把同一批代码编辑器延后并批量挂载，降低打开大型开发会话时的主线程冻结。

原项目实测记录：多个长会话约 624 个编辑器场景中，累计长任务 41.4s → 20.0s，最长单次冻结 8.5s → 1.1s。该数据来自项目既有实测，不代表所有机器的固定收益。

## 任务生命体征

插件综合以下证据，而不是只相信一个红色错误提示：

- 页面自己的 `/stream_status`；
- 低频独立状态探针；
- `/conversation/resume` 结果；
- ChatGPT 后端网络成功/失败；
- 最终 assistant 回复是否真正写入 conversation；
- 可选 DevHub Session/Task liveness。

常见状态包括：

- **有近期运行中证据**；
- **前端断流，但后台状态仍报运行中**；
- **后台已结束，等待最终回复落盘**；
- **执行已结束，但最终回复未落盘**；
- **429 限流中**；
- **网络/代理链路异常**；
- **疑似真正终止且未落盘**。

`stream_status=COMPLETE` 不会直接等于“任务成功”：插件会低频核验最终回复是否真正落盘。

## 请求降频

默认对会话列表和会话详情启用跨标签页协调、短路缓存、真实请求最小间隔和 429 退避。`stream_status` 不做暴力长期缓存，只保留为生命体征并在必要时低频独立校验。

## ChatGPT Project → DevHub 自动路由

插件可被动读取 ChatGPT Project/会话元数据，按项目名或会话标题自动映射到 DevHub。内置示例：

- `sxt加速A/B/C` → `sxt / WORKER-A/B/C`
- `sxt评审` → `sxt / REVIEWER-A`
- `XYZL-A/B/C开发` → `xyzl / WORKER-A/B/C`

推荐每个 DevHub 项目只配置一个 Manager evidence Token；令牌默认只保存在 `chrome.storage.session`，仅在用户主动勾选“持久保存”时写入 `chrome.storage.local`，不会进入 Chrome Sync。

## 升级

为了保留 DevHub 配置和令牌：

1. 不要删除旧扩展；
2. 把新版文件覆盖到原扩展目录；
3. 在扩展管理页点“重新加载”；
4. 刷新 ChatGPT 页面。

配置页提供普通配置/完整配置导入导出，便于迁移和备份。

## 开发与验证

```bash
npm ci
npm test
npm run package:stage
```

测试包含原 LongChat Perf 的 jsdom 性能补丁回归，以及任务生命体征核心逻辑、自动项目路由和运行时文件完整性检查。

## 隐私与网络

本版本不再是“完全无网络请求”的单一渲染补丁：任务生命体征功能需要观测/协调 ChatGPT 自己的后端请求，并在用户启用时连接 DevHub。详情见 [PRIVACY.md](PRIVACY.md)。扩展没有第三方统计、广告或遥测。

## 许可证

MIT。
