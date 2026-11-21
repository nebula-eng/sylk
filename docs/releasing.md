# 发版

Sylk 用 tag 触发 GitHub Actions 构建 Windows 安装包并发布到 Releases。发布包**不含**第三方引擎。

## 1. 同步版本号

版本号在四个文件里，必须一致：

- `package.json` / `package-lock.json`（`npm version X.Y.Z --no-git-tag-version` 会同时改）
- `src-tauri/Cargo.toml`（`Cargo.lock` 会在下次构建时更新）
- `src-tauri/tauri.conf.json`
- `CHANGELOG.md`：新增 `## [X.Y.Z] - YYYY-MM-DD` 段

发布工作流会校验 tag 与 `package.json` / `tauri.conf.json` / `Cargo.toml` 的版本是否一致。

## 2. 更新 CHANGELOG

按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 写「修复 / 新增 / 文档」，
面向用户写清楚「原来怎样、现在怎样、需要做什么」。发布说明会从这一段自动生成。

## 3. 本地预检

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all-targets
npm run typecheck
npm run build
```

再打一次安装包确认体积：

```powershell
npm run setup -- --dist
Get-Item src-tauri/target/release/bundle/nsis/*.exe |
  Select-Object Name, @{n="MB";e={[math]::Round($_.Length/1MB,2)}}
```

正常约 3.1 MB。超过 15 MB 说明第三方引擎或额外资源被误打包，不要发布。

## 4. 提交并打 tag

```powershell
git add -A
git commit -m "release: vX.Y.Z"
git push
git tag -a vX.Y.Z -m "Sylk X.Y.Z"
git push origin vX.Y.Z
```

## 5. 工作流

tag 推送后自动运行 `.github/workflows/release.yml`：

1. 检查 `src-tauri/engine/*.zip` 不存在；
2. 安装依赖，`npm run setup -- --dist` 构建前端、Rust 与 NSIS 安装包；
3. 校验安装包 < 15 MB；
4. 从 CHANGELOG 生成 release-notes.md；
5. 生成 `SHA256SUMS.txt`，上传安装包并发布 Release。

在 Actions 页面确认 `Release` 工作流为 success，且 Release 资产包含：

- `Sylk_X.Y.Z_x64-setup.exe`
- `SHA256SUMS.txt`

## 6. 发布后检查

- 从 Releases 下载安装包，在一台干净的 Windows 上安装并启动一次；
- 核对安装包 SHA256：`Get-FileHash .\Sylk_X.Y.Z_x64-setup.exe -Algorithm SHA256`；
- 检查 Release 说明里版本、CHANGELOG 段落、下载链接正常；
- README 不需要手改版本号，使用 `releases/latest` 动态链接；
- 需要撤回时：先删除 Release 与远程 tag，再修版本重新发；不要复用已发布的 tag。

## 7. 手动重跑

Actions → Release → Run workflow。手动触发可以选择只生成草稿，但不会自动打 tag；
正式发布仍建议走 tag，保证版本与 CHANGELOG 对应。
