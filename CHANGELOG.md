# 更新日志（CHANGELOG）

本项目的版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)（主版本.次版本.修订号）。

## [1.2.0] - 2026-09-07

### 新增

- **视频解析下载**：画中画小窗控制条新增 ⭳ 下载按钮，支持：
  - http(s) 直链视频（mp4/webm 等）走浏览器下载器后台下载
  - m3u8 / HLS 流媒体：解析播放列表 → 并发 4 线程下载分片 → AES-128 解密 → 合并 `.ts` 落盘
  - master 多码率播放列表自动选择 BANDWIDTH 最高的变体
  - fMP4 初始化段（`EXT-X-MAP`）支持
  - MSE 流式播放页面（B 站 / YouTube 等）：`webRequest` 后台嗅探 m3u8 地址（`storage.session` 缓存最近 10 条，SW 重启不丢）
  - 直播流（无 `EXT-X-ENDLIST`）与 DRM（SAMPLE-AES）明确报错不支持
- **自愈注入**：扩展安装/重载前已打开的标签页，打开弹窗或触发快捷键/右键菜单时自动补注入 content script，免刷新
- 右键菜单入口「画中画播放(窗口大小可拖拽)」（contexts: video）

### 优化

- offscreen 文档 ping/pong 握手：后台等到 offscreen 脚本加载完成才派发 m3u8 任务，避免消息早于监听器注册而丢失；创建失败自动重试
- m3u8 下载全程进度/调试信息通过 toast 实时显示（`m3u8-progress` / `m3u8-debug` / `m3u8-done`）
- 下载产物统一经后台 `chrome.downloads` API 落盘（offscreen 内 `a.click()` 自动下载会被浏览器多文件拦截）
- Blob 对象 URL 延迟 180 秒回收，避免大文件未落盘就被释放

### 修复

- MV3 Service Worker 中 `runtime.sendMessage` 无法广播到 content scripts 的问题：改为 `tabs.sendMessage` 定向转发任务消息
- Document PiP 窗口 `resizeTo` 以窗口**外框**为参数导致的尺寸偏差：先测量边框差，统一以内容尺寸为准
- 激活状态过期时拖拽调整大小反复抛 `NotAllowedError`：捕获后置位停止，不再循环报错
- 扩展重载后旧 content script 残留：加载时清理旧悬浮按钮/确认层，并接管遗留画中画窗口（视频放回页面原位后关闭）
- 扩展重载后旧世界 `window.__vpipLoaded` 标志阻止新脚本初始化的问题（每个 isolated world 独立标志）

## [1.1.0] - 2026-09-04

### 新增

- Document PiP 小窗内嵌完整控制条：播放/暂停、进度拖动、音量/静音、实时尺寸显示
- 四条边 + 四个角的拖拽调整（8 方向 cursor），宽高互不锁定
- 尺寸自动记忆：`chrome.storage.local` 持久化（节流 400ms），下次开启直接应用
- 浏览器忽略初始尺寸时的「应用上次尺寸 W × H」兜底按钮；双击角部恢复默认 512×320
- 原位置占位提示「画中画播放中」，关闭小窗视频自动放回原处

### 优化

- 视频拾取策略：多视频页面自动选择可见面积最大的视频
- 悬浮按钮在全屏元素内的挂载处理（`ensureBtnParent`）
- 直播流（`duration` 非有限值）显示「直播」并禁用进度条

## [1.0.0] - 2026-09-02

### 新增

- 首个公开版本
- 悬浮按钮（hover 视频浮现）一键开启画中画
- Document Picture-in-Picture 自定义小窗 + 原生 `requestPictureInPicture()` 自动回退
- 工具栏弹窗：页面状态检测（视频数 / 运行中 / 不支持原因）+ 默认窗口尺寸设置
- 快捷键 `Alt+P` 开关画中画
- 手势受限（`NotAllowedError`）时的一次性确认层
- 图标生成器：纯 Node 手写 PNG 编码器（CRC32 / zlib / IHDR / IDAT），零第三方依赖
- 自动化验收测试 25 项（puppeteer-core + Chrome for Testing）

[1.2.0]: https://github.com/<你的用户名>/video-pip-plus/releases/tag/v1.2.0
[1.1.0]: https://github.com/<你的用户名>/video-pip-plus/releases/tag/v1.1.0
[1.0.0]: https://github.com/<你的用户名>/video-pip-plus/releases/tag/v1.0.0
