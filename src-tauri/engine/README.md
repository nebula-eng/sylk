# 引擎包放这里（可选，且**不要提交**）

这个目录只在“自用构建”时放第三方引擎包。默认发布构建**不包含任何引擎二进制**。

```bash
npm run setup -- --engine=D:/Downloads/NapCat.Shell.zip
```

`--engine=<zip>` 会把包复制成 `src-tauri/engine/NapCat.Shell.zip`，仅在这一次构建里作为
Tauri 资源打进安装包；装好之后首次启动直接从本地解压，全程不联网。仓库里的 `.gitignore`
会忽略这里的 `*.zip`。

## 为什么仓库里不带

NapCat 上游（`NapNeko/NapCatQQ`）已于 2026-11-12 清空，仓库里保留的是一份
“Limited Redistribution License”性质的第三方代码/二进制：

- 未获作者明确许可，不得使用、修改或分发；
- 允许在附带完整许可文本、标明来源与版权的前提下再分发，且不得公开分发修改版；
- 不得用于商业用途。

把它打进安装包再分发，属于未授权再分发。项目也不替用户下载后转手分发。
自己机器上用不涉及再分发，合规；所以这里只放你自己的那份。

有明确开源许可的替代实现（如 GPL-2.0 的 LLBot）可以合法分发，但需要单独集成。

## 关于新版 QQ：V8 兼容引擎包

2026-11 之后的 QQ（9.9.37-54395 起）给 `package.json` / `application.asar` 等关键文件
加了 RSA 签名校验，并弃用了 `package.json.main`。NapCat 经典的“挂起进程 + package.json
重定向”在这类版本上会直接弹「文件已损坏」并退出。

社区后来用 **V8 编译期注入** 解决：在 QQ 目录放一个合法的 `winmm.dll` 侧加载代理，
在 QQ 主进程内 hook `v8::ScriptCompiler::Compile*`，把引导脚本插到解密后的启动脚本前，
再 `import` 同目录的 `napcat.mjs`。全程不改 QQ 文件，因此不触发签名校验。

这类“V8 兼容引擎包”同样受上面的许可限制，**不进仓库、不进安装包**。Sylk 只做识别与托管：

```
<QQ 便携目录>/
├─ QQ.exe
├─ winmm.dll              # V8 侧加载代理
├─ snowcat-boot.js        # 引导脚本
├─ napcat.mjs             # 单文件引擎包
├─ native/                # 引擎原生依赖
└─ versions/<ver>/...     # 官方 QQ 运行时
```

在设置 → 引擎 → 「QQ NT 安装目录」里指向这个目录，Sylk 会自动识别并改走 V8 启动路径：
拉起 `QQ.exe`、把 `NAPCAT_WORKDIR` 指到该目录、读 `cache/qrcode.png` 出二维码。

## 没有引擎包会怎样

构建照常通过，装出来的应用不含引擎。首次启动会引导你指定本机已有的 NapCat 目录、
导入压缩包、或连接外部 OneBot 实现——三条路都在界面上，不是空壳。
