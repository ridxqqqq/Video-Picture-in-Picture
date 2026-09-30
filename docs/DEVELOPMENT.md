# 开发文档（DEVELOPMENT）

本文面向想读懂 / 修改本扩展源码的开发者。所有源码在 `extension/` 下，纯原生 JS（ES2020+），无构建、无依赖。

## 总体架构

四个运行环境，通过 Chrome 消息通道协作：

```
┌────────────────┐                    ┌─────────────────────────────┐
│ popup.html/js  │  tabs.sendMessage  │ background.js (MV3 SW)      │
│ 状态检测/尺寸偏好 │───────────────────▶│ · contextMenus / commands   │
└────────────────┘  ensureReady 补注入 │ · m3u8 嗅探(webRequest 只读) │
                                       │ · 下载编排(downloads API)    │
                                       └──────────┬──────────────────┘
                                                  │ tabs.sendMessage
                                       ┌──────────▼──────────────────┐
                                       │ content.js / content.css     │
                                       │ · 悬浮按钮(每帧定位/节流隐藏)   │
                                       │ · Document PiP 自定义小窗     │
                                       │ · 8 向拖拽 + 尺寸记忆          │
                                       │ · resolveVideoSource 下载入口  │
                                       └──────────┬──────────────────┘
                                    ⭳ m3u8 时 runtime 消息
                                       ┌──────────▼──────────────────┐
                                       │ offscreen.js (BLOBS 文档)    │
                                       │ · fetch playlist(扩展级,CORS 豁免)│
                                       │ · 4 并发分片下载(保序)         │
                                       │ · AES-128(CBC) 解密            │
                                       │ · Blob 合并 → save-blob 回传    │
                                       └─────────────────────────────┘
```

### 消息协议（`vpip:*`）

| 消息 | 方向 | 载荷 / 返回 | 说明 |
| --- | --- | --- | --- |
| `vpip:query` | bg/popup → content | ← `{videos, docPip}` | 探测内容脚本是否就绪 + 页面视频数 |
| `vpip:open` | bg/popup → content | ← `{ok, mode}` | 拾取视频并开关画中画 |
| `vpip:download` | content → bg | `{url, filename}` | 直链视频交给 downloads API |
| `vpip:save-blob` | offscreen → bg | `{url(blob), filename}` | 合并产物落盘 |
| `vpip:get-captured-m3u8` | content → bg | ← `{ok, url}` | 取该标签页最近嗅探到的 m3u8 |
| `vpip:download-m3u8` | content → bg | `{url, filename, dlId}` | 发起 m3u8 下载任务（单任务互斥 `m3u8Busy`） |
| `vpip:m3u8-ping` / pong | bg ↔ offscreen | — | offscreen 就绪握手（最多等 8s，失败重建再试） |
| `vpip:m3u8-start` | bg → offscreen | `{url, filename, dlId}` | 派发解析下载任务 |
| `vpip:m3u8-progress` | offscreen → bg → content | `{dlId, done, total}` | 分片进度（每 2 片上报一次） |
| `vpip:m3u8-debug` | 同上 | `{dlId, text}` | 管线调试信息（toast 展示） |
| `vpip:m3u8-done` | 同上 | `{dlId, ok, filename, message}` | 完成后 bg 关闭 offscreen 文档（延迟 2s） |

> **MV3 坑**：`runtime.sendMessage` 从 Service Worker 广播**不会**投递给 content scripts，必须用 `tabs.sendMessage(tabId, …)` 定向转发——`forwardToJob()` 就是为此存在。

## 关键实现

### 1. 画中画的三级策略（content.js `togglePip`）

1. 已有 Document PiP 窗口 → 视为关闭（视频放回原位）
2. 顶层窗口 + 支持 `documentPictureInPicture` → `openDocPip()`（自定义小窗，完整控制条）
3. 否则 → `nativePip()`（原生 `requestPictureInPicture()`，iframe 内视频走这条）

`openDocPip` 细节：

- `resizeTo()` 的参数是**外框尺寸**，先测 `outerWidth - innerWidth` 边框差 `bx/by`，所有尺寸计算统一用「内容尺寸」，换算后再调用
- 视频元素**移动**进小窗 DOM（播放不中断），原位置插一个等尺寸占位 `__vpip_placeholder`
- `pagehide` 时把视频插回原父节点原位置，恢复 `controls`，移除全部事件监听（`vL` 登记表）
- 拖拽：8 个把手 `vp-rs-{n,s,w,e,ne,nw,se,sw}`，`w/n` 方向同步 `moveTo` 保持对边不动；`NotAllowedError`（激活过期）只提示一次不再循环抛错
- 尺寸记忆：`resize` 事件 → 400ms 节流写 `chrome.storage.local {w,h}`；开启时读回并 clamp 到 `[260×160, 屏幕可用区]`

### 2. m3u8 下载管线（background.js + offscreen.js）

**嗅探**（background.js）：`webRequest.onBeforeRequest` 按 URL 后缀匹配 `.m3u8`；`onHeadersReceived` 按 `content-type: *mpegurl*` 兜底。结果存 `chrome.storage.session`（SW 被杀也不丢），每标签页保留最近 10 条。

**编排**（background.js）：`ensureOffscreen()` → ping/pong 握手（未就绪自动重建，重试两轮）→ `m3u8-start` 派发。同一时间只允许一个任务（`m3u8Busy`），完成后延迟 2s 关闭 offscreen 文档释放资源。

**执行**（offscreen.js）：

1. 拉 playlist 文本；含 `EXT-X-STREAM-INF` 则为 master，选 BANDWIDTH 最高的变体再拉一层
2. 校验 `EXTINF` 存在、`EXT-X-ENDLIST` 存在（否则是直播流，报错）
3. 解析 `EXT-X-KEY`：仅支持 `AES-128`（`crypto.subtle` AES-CBC；IV 取显式 `0x…`，缺省用 64 位大端 media sequence）；`SAMPLE-AES` 等 DRM 直接报错
4. 解析 `EXT-X-MAP`（fMP4 初始化段）并预取
5. 4 并发 worker 按 index 保序下载分片（`fetchBuf` 失败重试 2 次，退避 500ms×n），每 2 片上报进度
6. `[init, seg0, seg1, …]` 依序合并为 `video/mp2t` Blob → `createObjectURL` → `vpip:save-blob` 交后台 downloads API 落盘（offscreen 里 `a.click()` 会被多文件下载策略拦截，故必须走后台）→ 180s 后 `revokeObjectURL`

**下载入口判定**（content.js `resolveVideoSource`）：`srcObject` → 直播流；`.m3u8` → HLS；`.mpd` → DASH（暂不支持）；`blob:` → 先查后台嗅探结果，命中则走 m3u8 管线，未命中且同源则 fetch 后另存；`http(s)/data:` → 直链。

### 3. 自愈注入（免刷新）

`ensureContent(tabId)` / popup 的 `ensureReady()`：先 `vpip:query` 探测，`nocontent/noresponse` 说明脚本不在（刚装/刚重载、或 Chrome 窄屏注入竞态），立即 `insertCSS + executeScript(injectImmediately)` 补注入，再二次确认。content.js 用 `window.__vpipLoaded` 防重复初始化（isolated world 间隔离，重载后新 world 的标志是干净的，天然不冲突），并主动清理旧 world 残留的按钮/确认层/遗留小窗。

### 4. 权限最小化的取舍

- `webRequest` **只观察不修改**（未注册 `blocking` / `requestBody`），仅嗅探 m3u8 地址
- `<all_urls>` host 权限是 content script 全站可用 + offscreen 扩展级 fetch 跨源分片所必需；扩展不发起任何上报
- `storage.session` 存嗅探结果，浏览器会话结束自动清空，不落盘

## 文件清单

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `extension/manifest.json` | 35 | MV3 清单：权限、content_scripts、commands（Alt+P） |
| `extension/background.js` | 187 | SW：菜单/快捷键/补注入/嗅探/下载编排/offscreen 生命周期 |
| `extension/content.js` | 562 | 悬浮按钮、三级 PiP 策略、自定义小窗与拖拽、下载入口 |
| `extension/content.css` | 84 | 悬浮按钮/占位/toast/确认层样式 |
| `extension/popup.html` | 37 | 弹窗骨架：状态卡、开启按钮、尺寸设置 |
| `extension/popup.js` | 107 | 弹窗逻辑：ensureReady 自愈、状态渲染、偏好读写 |
| `extension/popup.css` | 92 | 弹窗样式 |
| `extension/offscreen.html` | 10 | offscreen 文档壳 |
| `extension/offscreen.js` | 145 | m3u8 解析/并发下载/AES-128 解密/合并 |
| `extension/icons/` | — | 16/48/128 PNG（`test/icon-gen.js` 生成） |
| `test/test.js` | 486 | 25 项自动化验收（puppeteer-core） |
| `test/icon-gen.js` | 109 | 图标生成器（手写 PNG 编码器，SDF 抗锯齿，4×超采样） |
| `test/debug-pip.js` / `debug-pip2.js` | 71/109 | 手动调试脚本（开启 PiP / 拖拽过程观察） |
| `test/page*.html` | — | 测试页：普通视频 / blob 同源 / MSE / m3u8（明文与 AES-128） |

## 修改指南速查

| 想改什么 | 位置 |
| --- | --- |
| 默认/最小窗口尺寸 | `content.js` 顶部 `DEFAULT_W/H`、`MIN_W/H` |
| 小窗配色、控制条布局 | `content.js` 内 `PIP_CSS` 与 `doc.body.innerHTML` 模板 |
| m3u8 并发数、重试 | `offscreen.js` 的 `CONC`、`fetchBuf(…, retries)` |
| 嗅探保留条数 | `background.js` `pushM3u8` 的 `slice(-10)` |
| 快捷键 | `manifest.json` `commands`（用户侧可在 `chrome://extensions/shortcuts` 覆盖） |
| 新增下载类型 | `content.js` `resolveVideoSource` 返回新 kind → `handleDownload` 加分支 |

## 已知限制

- m3u8 仅支持 **VOD**（需要 `EXT-X-ENDLIST`），直播流不支持
- 仅支持 AES-128 明文密钥加密；SAMPLE-AES / Widevine 等 DRM 不支持（也不应支持）
- DASH（`.mpd`）暂不支持
- Document PiP 依赖 Chrome 116+；更早内核走原生 PiP 回退（无自定义控制条）
- offscreen 合并产物整段驻留内存，超长视频（>1GB）可能吃紧
