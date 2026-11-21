## 这次改了什么

<!-- 一句话说明目的；关联 issue 可写 Fixes #123 -->

## 类型

- [ ] 修复
- [ ] 功能
- [ ] 重构 / 性能
- [ ] 文档 / 构建 / CI
- [ ] 隐私或安全相关

## 检查

- [ ] `cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check`
- [ ] `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings`
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml`
- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] 手动验证了改动涉及的界面或命令（说明怎么验的）

## 隐私与第三方边界

- [ ] 没有提交真实账号、群名、联系人、语音、转写文本或截图
- [ ] 没有把第三方引擎包（NapCat / 兼容引擎包）或安装包放进仓库
- [ ] 新增的网络请求、日志字段、落盘路径已检查过脱敏与边界校验
