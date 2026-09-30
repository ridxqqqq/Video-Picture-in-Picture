# 测试指南（TESTING）

`test/` 目录包含一套 **25 项自动化验收测试**（puppeteer-core 驱动真实 Chromium 窗口，非 headless——Document PiP 依赖真实窗口）和配套工具。历史实测：**25/25 全部通过**（Chrome for Testing 152，2026-09-07）。

## 环境准备

| 依赖 | 说明 |
| --- | --- |
| Node.js ≥ 18 | 运行测试与工具脚本 |
| Chrome for Testing（或任意支持 `--load-extension` 的 Chromium 系浏览器） | 默认查找路径在 `test.js` 头部 `CANDIDATES` 数组，可放 `test/chrome/chrome-win64/chrome.exe` 或改为系统 Chrome 路径 |

```powershell
cd test
npm install          # 安装 puppeteer / puppeteer-core（仅测试用，扩展本体零依赖）
node test.js         # 跑全部 25 项
```

> 注意：`test.js` 通过 `--load-extension=<仓库>/extension` 加载扩展，因此 **`test/` 目录必须与 `extension/` 目录保持在同一父目录下**（仓库结构已保证）。
> 测试会启动本地静态服务器 `http://127.0.0.1:8931` 承载 `page*.html`，下载产物落在 `test/downloads-test/`（已 gitignore）。

## 测试页场景（test/page*.html）

| 页面 | 场景 |
| --- | --- |
| `page.html` | 普通直链视频（主测试页：悬浮按钮、拖拽、记忆尺寸） |
| `page2.html` | 同源 blob 视频（blob 另存路径） |
| `page3.html` | 多视频页面（自动选面积最大的视频） |
| `page4.html` | m3u8 场景（查询参数切换明文 / AES-128 加密流，配合本地 media server） |

## 25 项验收清单

**画中画核心（10 项）**

1. 悬浮按钮 hover 视频浮现、样式正确
2. 点击按钮 → Document PiP 窗口开启
3. 多视频页面自动选择可见面积最大的视频
4. 小窗内视频持续播放（时间前进）
5. 原位置占位提示出现
6. 四角/四边 8 向拖拽放大与缩小（宽高独立变化）
7. 拖拽后尺寸自动记忆（storage.local 落值）
8. 重新开启应用记忆尺寸；偏差过大时出现「应用上次尺寸」兜底按钮
9. 双击角部恢复默认 512×320
10. 关闭小窗后视频放回原位置、controls 恢复

**入口链路（4 项）**

11. 快捷键 Alt+P 开关
12. 右键菜单「画中画播放」
13. 弹窗状态检测（视频数 / 运行中 / 未检测到）
14. 弹窗「开启画中画」按钮

**健壮性（4 项）**

15. 直播流（无时长）显示「直播」、进度条禁用
16. 未注入页面自动补装脚本（免刷新自愈）
17. 内置页面（chrome:// 等）正确拒绝注入并给出提示
18. 手势受限 NotAllowedError → 一次性确认层

**下载（7 项）**

19. 下载按钮在控制条右下角就位
20. 直链视频真实下载落盘（256KB 产物字节级校验）
21. blob 视频同源另存
22. 直播流下载明确拒绝
23. m3u8 明文流解析下载 → `.ts` 产物校验
24. AES-128 加密 m3u8 解密下载 → 产物与源分片字节级校验
25. master 多码率自动选最高清变体；blob（MSE）页面嗅探捕获 m3u8 并下载

## 调试脚本

```powershell
node debug-pip.js    # 开启画中画并保持窗口，观察控制条/拖拽行为
node debug-pip2.js   # 拖拽过程数值观察（resize 事件、storage 写入节流）
```

## 重新生成图标

```powershell
node icon-gen.js     # 输出 extension/icons/icon{16,48,128}.png
```

纯 Node 实现的手写 PNG 编码器（CRC32 + zlib.deflate + IHDR/IDAT/IEND chunk），图形用 SDF（有向距离场）绘制、4×4 超采样抗锯齿：圆角矩形屏幕 + 播放三角 + 右下画中画小窗，indigo→purple 渐变底。改完图标后记得在 `chrome://extensions/` 重载扩展。

## CI 提示（可选）

测试依赖真实窗口与非内建浏览器二进制，GitHub Actions 上跑需要 `xvfb-run` + 下载 Chrome for Testing artifact；本仓库暂未配置 CI，本地跑即可。
