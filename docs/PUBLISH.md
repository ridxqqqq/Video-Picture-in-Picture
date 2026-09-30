# 发布指南（PUBLISH）

从当前目录把项目发布到 GitHub 的完整步骤（假设仓库名 `video-pip-plus`，按需替换）。

## 1. 首次发布

### 1.1 建仓库并首推

```powershell
cd <本仓库目录>

git init
git add .
git commit -m "feat: 视频画中画 Plus v1.2.0 首个公开版本"

# 在 GitHub 网页上新建空仓库（不要勾选 README/LICENSE 初始化）后：
git branch -M main
git remote add origin https://github.com/<你的用户名>/video-pip-plus.git
git push -u origin main
```

> 提交前建议先浏览一遍 `.gitignore` 已排除的内容（`test/chrome/`、`test/downloads-test/` 等大文件目录），确认 `git status` 干净。

### 1.2 打 tag 并发 Release（附带发行 zip）

```powershell
git tag -a v1.2.0 -m "v1.2.0: 视频解析下载 + 自愈注入"
git push origin v1.2.0

# 用 GitHub CLI（可选，没有 gh 就在网页 Releases → Draft a new release）：
gh release create v1.2.0 releases/video-pip-plus-v1.2.0.zip `
  --title "v1.2.0 视频解析下载" `
  --notes "新增：小窗内一键解析下载视频（直链 / m3u8 含 AES-128 / MSE 嗅探）；安装方式见 README。SHA-256 见 README。"
```

### 1.3 建议的仓库设置

- **About 栏**：一句话简介 + topics（`chrome-extension`、`picture-in-picture`、`m3u8`、`hls-downloader`、`manifest-v3`）
- **Branch protection**（可选）：main 禁止 force push
- 若以后想在 Chrome Web Store 上架：把 `extension/` 打 zip 上传到 [开发者后台](https://chrome.google.com/webstore/devconsole)，一次性 $5 注册费；本扩展权限较多（`<all_urls>`），上架会触发人工审核，需在审核备注里说明用途

## 2. 日常更新流程

```powershell
# 1) 改代码 → 更新 manifest.json 的 version（三段式递增）
# 2) 在 CHANGELOG.md 顶部补一节 [x.y.z] - 日期
# 3) 若图标有变：cd test && node icon-gen.js
# 4) 重打发行包：
Compress-Archive -Path extension/* -DestinationPath releases/video-pip-plus-vx.y.z.zip -Force
Get-FileHash releases/video-pip-plus-vx.y.z.zip -Algorithm SHA256   # 记录并写进 README

# 5) 全量验收（见 docs/TESTING.md）：
cd test; npm install; node test.js

# 6) 提交 + tag + Release（同 1.2）
```

## 3. 版本号约定

遵循语义化版本：

- **主版本**：破坏性变更（如移除某入口、改变存储结构且不迁移）
- **次版本**：向后兼容的功能新增（如新增下载类型、新增 UI）
- **修订号**：bug 修复、文案微调

## 4. 发布前自查清单

- [ ] `manifest.json` 的 `version` 已递增
- [ ] `CHANGELOG.md` 已补对应小节
- [ ] README 的版本号、SHA-256、下载文件名已同步
- [ ] `node test.js` 25 项全部通过
- [ ] 发行 zip 内是 `extension/` 的**内容**（解压后直接有 manifest.json），不是包了一层目录
- [ ] `git status` 无意外文件（大文件已被 `.gitignore` 排除）
- [ ] 新权限或行为变化已在 README「权限说明」中解释
