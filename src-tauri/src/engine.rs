//! 内嵌引擎：把 NapCat 当成 Sylk 自己的一个子系统来托管。
//!
//! 这一层解决的问题不是「把文件塞进安装包」，而是把原本要用户手动完成的一串动作
//! 全部收回程序内部：找 QQ、挑端口、写配置、拉起进程、读二维码、判存活、崩溃重启、
//! 退出清理。用户看到的只有两件事：一张二维码，和一个已经连上的账号。
//!
//! 三条设计约束：
//! 1. **端口与令牌由 Sylk 生成**，只绑回环，用户永远不需要看到或填写。
//! 2. **配置由 Sylk 独占**（`config/onebot11.json` + `config/webui.json`），
//!    每次启动重写一遍，保证幂等 —— 用户改了也不会坏，改坏了也会被修正回来。
//! 3. **存活判断以接口为准**，日志只用来提供过程感。日志文案会随版本变化，
//!    `get_login_info` 不会。

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::json;
use tauri::{AppHandle, Emitter};

use crate::error::{AppError, AppResult};
use crate::models::{Account, EngineSettings, EngineStatus};
use crate::napcat::NapcatClient;

pub const EV_ENGINE: &str = "sylk://engine";
const MAX_LOGS: usize = 400;
const PREFERRED_HTTP: u16 = 13_700;

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct Runtime {
    pub phase: String,
    pub detail: String,
    pub mode: String,
    pub napcat_dir: String,
    pub qq_dir: String,
    pub http_port: u16,
    pub ws_port: u16,
    pub token: String,
    pub pid: Option<u32>,
    pub qr_version: u64,
    pub started_at: i64,
    pub account: Option<Account>,
    pub logs: VecDeque<String>,
    /// 本轮启动是否已经因为端口冲突重试过，避免无限循环
    pub retried: bool,
    /// 上一次失败的原因。status() 会用固定文案覆盖 detail，
    /// 这个字段让「为什么失败」能穿过那次覆盖留在界面上。
    pub last_error: String,
}

impl Default for Runtime {
    fn default() -> Self {
        Self {
            phase: "idle".into(),
            detail: "引擎未启动".into(),
            mode: "embedded".into(),
            napcat_dir: String::new(),
            qq_dir: String::new(),
            http_port: 0,
            ws_port: 0,
            token: String::new(),
            pid: None,
            qr_version: 0,
            started_at: 0,
            account: None,
            logs: VecDeque::new(),
            retried: false,
            last_error: String::new(),
        }
    }
}

#[derive(Default)]
pub struct Engine {
    pub rt: Mutex<Runtime>,
    pub child: Mutex<Option<Child>>,
    pub qr: Mutex<Option<Vec<u8>>>,
    /// 端点变更计数：流水线据此立刻重连，不必等退避。
    pub epoch: AtomicU64,
    /// 启动互斥：应用自动启动与登录页自动启动可能同时发生，
    /// 没有它就会拉起两个 QQ + 两个引擎，端口、登录态互相覆盖。
    pub start_guard: Mutex<()>,
}

impl Engine {
    pub fn rt(&self) -> MutexGuard<'_, Runtime> {
        self.rt.lock().unwrap_or_else(|err| err.into_inner())
    }

    pub fn log(&self, line: impl Into<String>) {
        let line = line.into();
        let mut rt = self.rt();
        if rt.logs.len() >= MAX_LOGS {
            rt.logs.pop_front();
        }
        rt.logs.push_back(line);
    }

    pub fn set_phase(&self, phase: &str, detail: impl Into<String>) {
        let mut rt = self.rt();
        rt.phase = phase.to_string();
        rt.detail = detail.into();
    }

    /// 当前可用的 OneBot 端点。embedded 模式下由引擎提供。
    pub fn endpoints(&self) -> Option<(String, String, String)> {
        let rt = self.rt();
        if rt.http_port == 0 {
            return None;
        }
        Some((
            format!("http://127.0.0.1:{}", rt.http_port),
            format!("ws://127.0.0.1:{}", rt.ws_port),
            rt.token.clone(),
        ))
    }

    pub fn status(&self, settings: &EngineSettings) -> EngineStatus {
        let rt = self.rt();
        let v8 = v8_dir(settings);
        let dir = if !rt.napcat_dir.is_empty() {
            rt.napcat_dir.clone()
        } else if let Some(path) = &v8 {
            path.to_string_lossy().to_string()
        } else {
            resolve_dir(settings)
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default()
        };
        let qq = if let Some(path) = &v8 {
            path.to_string_lossy().to_string()
        } else if rt.qq_dir.is_empty() {
            detect_qq(settings)
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default()
        } else {
            rt.qq_dir.clone()
        };
        let qq_found = !qq.is_empty() && Path::new(&qq).join("QQ.exe").is_file();
        let available = if v8.is_some() {
            true
        } else {
            !dir.is_empty() && entrypoint(Path::new(&dir)).is_some()
        };
        let launch_mode = if v8.is_some() { "v8" } else { "napcat" };
        let qq_version = installed_qq_version(settings).unwrap_or_default();

        let mut phase = rt.phase.clone();
        let mut detail = rt.detail.clone();
        if !available && phase != "preparing" {
            phase = "unavailable".into();
            detail = if !rt.last_error.is_empty() {
                rt.last_error.clone()
            } else if dir.is_empty() {
                "还没有引擎，点「自动查找本机引擎」或指定引擎目录".into()
            } else {
                "引擎文件不完整，重新指定目录或导入引擎包".into()
            };
        }

        EngineStatus {
            phase,
            detail,
            mode: if settings.mode.is_empty() {
                rt.mode.clone()
            } else {
                settings.mode.clone()
            },
            available,
            napcat_dir: dir,
            qq_dir: qq,
            qq_found,
            launch_mode: launch_mode.into(),
            qq_version,
            http_port: rt.http_port,
            ws_port: rt.ws_port,
            pid: rt.pid,
            qr_version: rt.qr_version,
            uptime: if rt.started_at > 0 {
                chrono::Local::now().timestamp() - rt.started_at
            } else {
                0
            },
            account: rt.account.clone(),
            logs: rt.logs.iter().cloned().collect(),
        }
    }
}

pub fn emit(app: &AppHandle, engine: &Engine, settings: &EngineSettings) {
    let status = engine.status(settings);
    let _ = app.emit(EV_ENGINE, status);
}

// ---------------------------------------------------------------------------
// 路径探测
// ---------------------------------------------------------------------------

/// 引擎默认落点：应用数据目录下，跟着 Sylk 一起走。
pub fn default_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("engine").join("napcat")
}

pub fn resolve_dir(settings: &EngineSettings) -> Option<PathBuf> {
    let configured = settings.napcat_dir.trim();
    if !configured.is_empty() {
        let path = PathBuf::from(configured);
        if path.is_dir() {
            return Some(path);
        }
    }
    None
}

/// V8 兼容模式：QQ 便携目录里直接带 `winmm.dll`（V8 编译期注入代理）、
/// `snowcat-boot.js`（引导脚本）与单文件 `napcat.mjs`。
///
/// 2026-11 之后的新版 QQ 弃用了 `package.json` 的 `main` 字段，并给
/// `application.asar` / `wrapper.node` / `major.node` / `package.json` 加了
/// RSA-2048 签名表。NapCat 经典的「挂起进程 + package.json 重定向」在这些
/// 版本上必然触发「文件已损坏」；V8 编译器通道绕开文件层校验，是这类版本的
/// 唯一可行接法。
///
/// 这类引擎包与 QQ 副本都是第三方分发物（NapCat 系许可证禁止未授权再分发），
/// Sylk 不随包提供、也不转手分发，只识别用户自备的目录并托管生命周期。
/// 一个目录是不是 V8 兼容引擎包：便携 QQ + 兼容层四个文件。
/// 这个判断同时被「指定已有目录」「导入压缩包」和本机扫描复用。
pub fn v8_bundle_at(path: &Path) -> Option<PathBuf> {
    if !path.is_dir() {
        return None;
    }
    let required = ["QQ.exe", "winmm.dll", "snowcat-boot.js", "napcat.mjs"];
    if required.iter().all(|name| path.join(name).is_file()) {
        Some(path.to_path_buf())
    } else {
        None
    }
}

pub fn v8_dir(settings: &EngineSettings) -> Option<PathBuf> {
    let configured = settings.qq_path.trim();
    if configured.is_empty() {
        return None;
    }
    v8_bundle_at(Path::new(configured))
}

/// 读 QQ 便携/安装目录里真实的客户端版本（`versions/config.json` 的 curVersion）。
fn qq_installed_version(qq_root: &Path) -> Option<String> {
    if let Ok(text) = std::fs::read_to_string(qq_root.join("versions").join("config.json")) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
            for key in ["curVersion", "baseVersion"] {
                if let Some(version) = value.get(key).and_then(|item| item.as_str()) {
                    if !version.is_empty() {
                        return Some(version.to_string());
                    }
                }
            }
        }
    }
    // 兜底：versions/<ver>/resources/app/package.json 里 build 号最大的一个
    let mut found: Option<(u64, String)> = None;
    if let Ok(entries) = std::fs::read_dir(qq_root.join("versions")) {
        for entry in entries.flatten() {
            if !entry.path().is_dir() {
                continue;
            }
            let Ok(raw) = std::fs::read_to_string(
                entry
                    .path()
                    .join("resources")
                    .join("app")
                    .join("package.json"),
            ) else {
                continue;
            };
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
                continue;
            };
            let Some(version) = value.get("version").and_then(|item| item.as_str()) else {
                continue;
            };
            let build = value
                .get("buildVersion")
                .and_then(|item| item.as_str())
                .and_then(|item| item.parse::<u64>().ok())
                .unwrap_or(0);
            if found
                .as_ref()
                .map(|(best, _)| build > *best)
                .unwrap_or(true)
            {
                found = Some((build, version.to_string()));
            }
        }
    }
    found.map(|(_, version)| version)
}

/// 引擎 `napcat.mjs` 内置支持的 QQ 版本列表。
///
/// NapCat 把所有兼容版本写成 `9.9.37-54276` 这类键（包偏移表 / appid 表）。
/// 这里不引入正则依赖，直接逐字符扫一遍；解析失败就当作「未知」放行，
/// 由运行时错误兜底。
pub fn supported_qq_versions(dir: &Path) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(dir.join("napcat.mjs")) else {
        return Vec::new();
    };
    let bytes = text.as_bytes();
    let mut out = Vec::new();
    let mut index = 0usize;
    while index + 4 < bytes.len() {
        if &bytes[index..index + 4] != b"9.9." {
            index += 1;
            continue;
        }
        let start = index;
        let mut cursor = index + 4;
        let mut suffix_digits = 0usize;
        while cursor < bytes.len() && (bytes[cursor] == b'.' || bytes[cursor].is_ascii_digit()) {
            if bytes[cursor].is_ascii_digit() {
                suffix_digits += 1;
            }
            cursor += 1;
        }
        let mut build_digits = 0usize;
        if suffix_digits >= 2 && cursor < bytes.len() && bytes[cursor] == b'-' {
            let mut build_cursor = cursor + 1;
            while build_cursor < bytes.len() && bytes[build_cursor].is_ascii_digit() {
                build_cursor += 1;
                build_digits += 1;
            }
            if build_digits >= 3 {
                out.push(text[start..build_cursor].to_string());
                index = build_cursor;
                continue;
            }
        }
        index += 1;
    }
    out.sort();
    out.dedup();
    out
}

/// 判断引擎退出后是否还有 QQ 在跑。
///
/// QQ 是单实例的：用户自己的 QQ 开着时，NapCat 拉起的新实例会把参数转交给旧进程
/// 然后静默退出，界面只会显示「引擎已退出（代码 1）」，用户不知道该先关 QQ。
///
/// 用 tasklist 而不是 WMI：后者首次调用要加载整个 CIM 子系统，实测能把启动流程
/// 堵住十几秒。这里只需要一个「有没有」，tasklist 亚秒级返回。
///
/// 只在引擎已经退出之后调用 —— 那时引擎自己拉起的 QQ 已经没了，
/// 还剩下的就是用户开着的那个。
#[cfg(windows)]
fn qq_running() -> bool {
    use std::os::windows::process::CommandExt;
    let mut command = Command::new("tasklist");
    command
        .args(["/FI", "IMAGENAME eq QQ.exe", "/NH"])
        .creation_flags(0x0800_0000);
    match command.output() {
        Ok(out) => String::from_utf8_lossy(&out.stdout)
            .to_lowercase()
            .contains("qq.exe"),
        Err(_) => false,
    }
}

#[cfg(not(windows))]
fn qq_running() -> bool {
    false
}

/// 引擎包自带的 qqnt.json 声明它适配哪个 QQ 版本。
///
/// 这个值和注入用的 hook DLL 是同一次构建产出的，必须和本机 QQ 对上。
/// 对不上时 hook 的偏移全错，QQ 起来几秒就崩，而引擎引导进程仍然活着，
/// 表现为「一直在启动」——不比对版本根本查不出原因。
fn bundled_qq_version(dir: &Path) -> Option<String> {
    let text = std::fs::read_to_string(dir.join("qqnt.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value.get("version")?.as_str().map(|text| text.to_string())
}

/// 本机 QQ 的版本号。优先读 `versions/config.json` 的 curVersion（权威），
/// 其次从版本目录里的 package.json 兜底。
fn installed_qq_version(settings: &EngineSettings) -> Option<String> {
    let root = detect_qq(settings)?;
    qq_installed_version(&root)
}

/// 找 QQ NT 的安装目录。先看设置，再查注册表，最后试几个约定路径。
pub fn detect_qq(settings: &EngineSettings) -> Option<PathBuf> {
    let configured = settings.qq_path.trim();
    if !configured.is_empty() {
        let path = PathBuf::from(configured);
        if path.is_dir() {
            return Some(path);
        }
    }

    #[cfg(windows)]
    {
        // 标准安装版把安装位置写在 HKLM\...\Tencent\QQNT 的 Install 值里；
        // 老版本/某些安装器用 InstallDir。两个都读，再看卸载信息兜底。
        for (root, key, name) in [
            ("HKLM", r"SOFTWARE\WOW6432Node\Tencent\QQNT", "Install"),
            ("HKLM", r"SOFTWARE\Tencent\QQNT", "Install"),
            ("HKLM", r"SOFTWARE\Tencent\QQNT", "InstallDir"),
            ("HKCU", r"SOFTWARE\Tencent\QQNT", "Install"),
            ("HKCU", r"SOFTWARE\Tencent\QQNT", "InstallDir"),
        ] {
            if let Some(dir) = read_reg_string(root, key, name) {
                let path = PathBuf::from(dir);
                if path.join("QQ.exe").is_file() {
                    return Some(path);
                }
            }
        }
        if let Some(uninstall) = read_reg_string(
            "HKLM",
            r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\QQ",
            "UninstallString",
        ) {
            let trimmed = uninstall.trim_matches('"');
            if let Some(parent) = Path::new(trimmed).parent() {
                if parent.join("QQ.exe").is_file() {
                    return Some(parent.to_path_buf());
                }
            }
        }
    }

    for candidate in [
        r"C:\Program Files\Tencent\QQNT",
        r"C:\Program Files (x86)\Tencent\QQNT",
        r"D:\Program Files\Tencent\QQNT",
    ] {
        let path = PathBuf::from(candidate);
        if path.join("QQ.exe").is_file() {
            return Some(path);
        }
    }
    None
}

#[cfg(windows)]
fn read_reg_string(root: &str, key: &str, name: &str) -> Option<String> {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::System::Registry::{
        RegGetValueW, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ,
    };

    let hive = match root {
        "HKLM" => HKEY_LOCAL_MACHINE,
        _ => HKEY_CURRENT_USER,
    };
    let wide = |text: &str| -> Vec<u16> {
        OsStr::new(text)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    };
    let sub = wide(key);
    let value = wide(name);

    let mut size: u32 = 0;
    // 先问长度
    let probe = unsafe {
        RegGetValueW(
            hive,
            sub.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut size,
        )
    };
    if probe != 0 || size == 0 {
        return None;
    }

    let mut buffer = vec![0u16; (size as usize / 2).max(1)];
    let ok = unsafe {
        RegGetValueW(
            hive,
            sub.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_SZ,
            std::ptr::null_mut(),
            buffer.as_mut_ptr() as *mut _,
            &mut size,
        )
    };
    if ok != 0 {
        return None;
    }
    let text = String::from_utf16_lossy(&buffer);
    Some(text.trim_end_matches('\0').to_string()).filter(|text| !text.is_empty())
}

/// 引擎目录里真正的入口。按可靠性排序，命中即用。
pub fn entrypoint(dir: &Path) -> Option<PathBuf> {
    let candidates = [
        "NapCatWinBootMain.exe",
        "napcat.bat",
        "launcher.bat",
        "launcher-win10.bat",
        "napcat.mjs",
        "index.mjs",
    ];
    for name in candidates {
        let path = dir.join(name);
        if path.is_file() {
            return Some(path);
        }
    }
    // 一键包常见：解压出 NapCat.XXXXX.Shell 子目录
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                for name in candidates {
                    let inner = path.join(name);
                    if inner.is_file() {
                        return Some(inner);
                    }
                }
            }
        }
    }
    None
}

fn is_node_entry(path: &Path) -> bool {
    matches!(
        path.extension().and_then(|ext| ext.to_str()),
        Some("mjs") | Some("js") | Some("cjs")
    )
}

fn node_binary(dir: &Path, settings: &EngineSettings) -> Option<PathBuf> {
    let configured = settings.node_path.trim();
    if !configured.is_empty() {
        let path = PathBuf::from(configured);
        if path.is_file() {
            return Some(path);
        }
    }
    // 引擎自带的 node（自动获取时会放进 runtime/node）
    if let Some(parent) = dir.parent() {
        let bundled = parent.join("node").join("node.exe");
        if bundled.is_file() {
            return Some(bundled);
        }
        // 一键包会把 node 放在 napcat 同级
        let sibling = dir.join("node.exe");
        if sibling.is_file() {
            return Some(sibling);
        }
    }
    which::which("node").ok()
}

/// 二维码文件的可能位置。不同发行版布局不一样，全都试一遍。
fn find_qrcode(dir: &Path) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = vec![
        dir.join("cache").join("qrcode.png"),
        dir.join("napcat").join("cache").join("qrcode.png"),
        dir.join("resources")
            .join("app")
            .join("napcat")
            .join("cache")
            .join("qrcode.png"),
    ];
    if let Ok(entries) = std::fs::read_dir(dir.join("versions")) {
        for entry in entries.flatten() {
            candidates.push(
                entry
                    .path()
                    .join("resources")
                    .join("app")
                    .join("napcat")
                    .join("cache")
                    .join("qrcode.png"),
            );
        }
    }
    candidates.into_iter().find(|path| path.is_file())
}

/// 配置文件目录，同样随布局变化。
fn config_dir(dir: &Path) -> PathBuf {
    let direct = dir.join("config");
    if direct.is_dir() {
        return direct;
    }
    let nested = dir.join("napcat").join("config");
    if nested.is_dir() {
        return nested;
    }
    if let Ok(entries) = std::fs::read_dir(dir.join("versions")) {
        for entry in entries.flatten() {
            let candidate = entry
                .path()
                .join("resources")
                .join("app")
                .join("napcat")
                .join("config");
            if candidate.is_dir() {
                return candidate;
            }
        }
    }
    // 都没找到就先建在根下，首次启动 NapCat 会沿用
    let _ = std::fs::create_dir_all(&direct);
    direct
}

/// 在引擎自己的缓存目录里找同名音频。
///
/// 这是「内嵌」带来的一个额外好处：Sylk 知道引擎装在哪，所以当 `get_record`
/// 因为 NapCat 那侧缺 ffmpeg 而失败时，可以直接去它的 cache 里把原件捞出来，
/// 交给前端解码。外部模式下没有这个信息，就只能靠消息段里的 path/url。
pub fn cached_audio(dir: &Path, file_name: &str) -> Option<PathBuf> {
    if file_name.is_empty() {
        return None;
    }
    let name = Path::new(file_name)
        .file_name()
        .map(|value| value.to_string_lossy().to_string())?;

    let roots = [dir.join("cache"), dir.join("napcat").join("cache")];
    for root in roots {
        if let Some(found) = search_file(&root, &name, 2) {
            return Some(found);
        }
    }
    None
}

fn search_file(root: &Path, name: &str, depth: usize) -> Option<PathBuf> {
    if depth == 0 {
        return None;
    }
    let entries = std::fs::read_dir(root).ok()?;
    let mut dirs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() {
            if path.file_name().map(|value| value == name).unwrap_or(false) {
                return Some(path);
            }
        } else if path.is_dir() {
            dirs.push(path);
        }
    }
    for dir in dirs {
        if let Some(found) = search_file(&dir, name, depth - 1) {
            return Some(found);
        }
    }
    None
}

// ---------------------------------------------------------------------------
// 端口与配置
// ---------------------------------------------------------------------------

fn random_token() -> String {
    // 走操作系统 CSPRNG（uuid v4），不再用时间戳哈希。
    crate::privacy::random_hex(24)
}

/// 同时占两个端口再一起释放，避免两次 bind 拿到同一个号。
fn reserve_ports() -> AppResult<(u16, u16)> {
    let bind = |port: u16| TcpListener::bind(("127.0.0.1", port));

    // 优先用 13700/13701，避开用户自己可能已经在用的 3000/3001。
    for offset in 0..12 {
        let base = PREFERRED_HTTP + offset * 2;
        let Ok(first) = bind(base) else { continue };
        let Ok(second) = bind(base + 1) else { continue };
        let http = first.local_addr()?.port();
        let ws = second.local_addr()?.port();
        return Ok((http, ws));
    }

    // 端口都被占了就交给系统分配
    let first = bind(0)?;
    let second = bind(0)?;
    let http = first.local_addr()?.port();
    let ws = second.local_addr()?.port();
    if http == ws {
        return Err(AppError::msg("无法分配两个不同的本地端口"));
    }
    Ok((http, ws))
}

/// 写配置：每次启动覆盖写，保证幂等。用户手改的内容不会留坑。
pub fn write_configs(dir: &Path, http_port: u16, ws_port: u16, token: &str) -> AppResult<()> {
    let config = config_dir(dir);
    std::fs::create_dir_all(&config)?;

    let webui = json!({
        "host": "127.0.0.1",
        "port": 0,
        "token": token,
        "loginRate": 3,
    });
    std::fs::write(
        config.join("webui.json"),
        serde_json::to_string_pretty(&webui)?,
    )?;

    // onebot11.json 是默认配置（NapCat v4.5.3+），对所有账号生效，
    // 所以不必等拿到 QQ 号就能预先配好。
    let onebot = json!({
        "network": {
            "httpServers": [{
                "name": "sylk-http",
                "enable": true,
                "host": "127.0.0.1",
                "port": http_port,
                "enableCors": true,
                "enableWebsocket": false,
                "messagePostFormat": "array",
                "token": token,
                "debug": false
            }],
            "httpSseServers": [],
            "httpClients": [],
            "websocketServers": [{
                "name": "sylk-ws",
                "enable": true,
                "host": "127.0.0.1",
                "port": ws_port,
                "messagePostFormat": "array",
                "reportSelfMessage": false,
                "token": token,
                "debug": false,
                "heartInterval": 30000
            }],
            "websocketClients": [],
            "plugins": []
        },
        "musicSignUrl": "",
        "enableLocalFile2Url": true,
        "parseMultMsg": false
    });
    std::fs::write(
        config.join("onebot11.json"),
        serde_json::to_string_pretty(&onebot)?,
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 进程
// ---------------------------------------------------------------------------

fn spawn_process(dir: &Path, entry: &Path, settings: &EngineSettings) -> AppResult<Child> {
    // 入口可能在发布包的嵌套子目录里；hook、引导脚本与工作目录都要跟着入口走。
    let root = entry
        .parent()
        .map(|path| path.to_path_buf())
        .unwrap_or_else(|| dir.to_path_buf());

    let mut command;
    if is_node_entry(entry) {
        let node = node_binary(dir, settings).ok_or_else(|| {
            AppError::msg("引擎需要 Node 运行时，但没找到。请在设置里指定 node.exe")
        })?;
        command = Command::new(node);
        command.arg(entry);
    } else if matches!(entry.extension().and_then(|ext| ext.to_str()), Some("bat")) {
        command = Command::new("cmd");
        command.arg("/C").arg(entry);
    } else {
        command = Command::new(entry);

        // NapCat 的引导程序要求两个位置参数：QQ.exe 与注入用的 DLL。
        // 不带参数时它会在两秒内静默退出，控制台什么都不打印——
        // 用户看到的就是「引擎已退出（代码 1）」而不知道为什么。
        if entry.file_name().and_then(|name| name.to_str()) == Some("NapCatWinBootMain.exe") {
            let qq_dir = detect_qq(settings).ok_or_else(|| {
                AppError::msg(
                    "没找到 QQ NT 的安装位置。引擎需要用它启动，请在设置里指定 QQ NT 目录。",
                )
            })?;
            let qq_exe = if qq_dir.extension().and_then(|ext| ext.to_str()) == Some("exe") {
                qq_dir
            } else {
                qq_dir.join("QQ.exe")
            };
            if !qq_exe.is_file() {
                return Err(AppError::msg(format!(
                    "QQ 启动文件不存在：{}",
                    qq_exe.display()
                )));
            }
            let hook = root.join("NapCatWinBootHook.dll");
            if !hook.is_file() {
                return Err(AppError::msg(format!(
                    "引擎缺少注入文件：{}",
                    hook.display()
                )));
            }
            command.arg(&qq_exe).arg(&hook);
        }
    }

    // Hook DLL 与 loadNapCat.js 只认这组环境变量（官方 launcher-user.bat 同样设置）。
    // 少了它们，hook 会安静地什么都不做，QQ 正常启动但 NapCat 永不加载。
    command
        .env("NAPCAT_PATCH_PACKAGE", dir.join("qqnt.json"))
        .env("NAPCAT_LOAD_PATH", root.join("loadNapCat.js"))
        .env("NAPCAT_INJECT_PATH", root.join("NapCatWinBootHook.dll"))
        .env("NAPCAT_LAUNCHER_PATH", entry)
        .env("NAPCAT_MAIN_PATH", root.join("napcat.mjs"))
        .env("NAPCAT_WORKDIR", dir)
        .env("NAPCAT_QQ_DATA_DIR", dir.join("qqdata"))
        .env("NAPCAT_ENABLE_VERBOSE_LOG", "1");

    command
        .current_dir(&root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW：不弹黑框。这是「融为一体」最直观的一步。
        command.creation_flags(0x0800_0000);
    }

    command
        .spawn()
        .map_err(|err| AppError::msg(format!("拉起引擎失败：{err}")))
}

/// V8 兼容模式：直接拉起 QQ。
///
/// QQ 目录里的 `winmm.dll` 是合法侧加载代理（QQ.exe 静态导入 WINMM，且它不在
/// KnownDLLs 里），它在 QQ 主进程内挂钩 V8 的 ScriptCompiler::Compile*，把
/// `snowcat-boot.js` 插到解密后的启动脚本前面；引导脚本再 import 同目录的
/// `napcat.mjs`。全程不改 QQ 文件，因此不触发签名完整性校验。
fn spawn_v8(dir: &Path) -> AppResult<Child> {
    let exe = dir.join("QQ.exe");
    if !exe.is_file() {
        return Err(AppError::msg(format!(
            "V8 引擎目录缺少 QQ.exe：{}",
            dir.display()
        )));
    }
    // 上一次登录成功的账号会写到 .sylk-account；带上 -q 可以走快速登录，
    // 用户不必每次打开应用都重新扫码。没有记录（或快速登录失败）时引擎会回落到二维码。
    let quick_uin = std::fs::read_to_string(dir.join(".sylk-account"))
        .ok()
        .map(|text| text.trim().to_string())
        .filter(|uin| !uin.is_empty() && uin.chars().all(|ch| ch.is_ascii_digit()));

    let mut command = Command::new(&exe);
    command.arg("--enable-logging");
    if let Some(uin) = &quick_uin {
        command.arg("-q").arg(uin);
    }
    command
        // 让 NapCat 把 config / cache / logs 落到 Sylk 指定目录：
        // QR 在 <dir>/cache/qrcode.png，OneBot 端点从 <dir>/config/onebot11.json 读。
        .env("NAPCAT_WORKDIR", dir)
        .env("NAPCAT_QQ_DATA_DIR", dir.join("qqdata"))
        .env("NAPCAT_ENABLE_VERBOSE_LOG", "1")
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }

    command
        .spawn()
        .map_err(|err| AppError::msg(format!("拉起 V8 引擎失败：{err}")))
}

fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        let mut command = Command::new("taskkill");
        command.args(["/PID", &pid.to_string(), "/T", "/F"]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000);
        }
        let _ = command.output();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill").args(["-9", &pid.to_string()]).output();
    }
}

fn pid_file(dir: &Path) -> PathBuf {
    dir.join(".sylk-engine.pid")
}

fn write_pid(dir: &Path, pid: u32) {
    let _ = std::fs::write(pid_file(dir), pid.to_string());
}

fn clear_pid(dir: &Path) {
    let _ = std::fs::remove_file(pid_file(dir));
}

/// 上次异常退出可能留下孤儿进程，启动前先清掉。
fn reap_orphan(dir: &Path, engine: &Engine) {
    let path = pid_file(dir);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return;
    };
    if let Ok(pid) = text.trim().parse::<u32>() {
        engine.log(format!("清理上次残留进程 {pid}"));
        kill_tree(pid);
        std::thread::sleep(Duration::from_millis(600));
    }
    clear_pid(dir);
}

// ---------------------------------------------------------------------------
// 启动 / 停止
// ---------------------------------------------------------------------------

/// 启动前版本门禁：引擎支持列表里没有本机 QQ 时拒绝注入。
///
/// NapCat 的兼容版本写死在 `napcat.mjs` 的版本表里。对不上时注入不会报错，
/// 而是 QQ 启动后判定关键文件被篡改、弹「文件已损坏」并退出——不提前拦截的话，
/// 用户每次点启动都会拿自己的 QQ 做一次失败实验。
fn check_qq_compat(dir: &Path, settings: &EngineSettings) -> AppResult<()> {
    let Some(installed) = installed_qq_version(settings) else {
        return Ok(());
    };
    let supported = supported_qq_versions(dir);
    if supported.is_empty() || supported.iter().any(|item| item == &installed) {
        return Ok(());
    }
    let newest = supported.last().cloned().unwrap_or_default();
    Err(AppError::msg(format!(
        "本机 QQ {installed} 不在当前引擎的支持列表内（最高支持 {newest}）。\
         QQ 9.9.37-54395 起新增了关键文件的签名校验，旧式注入会被判定为「文件已损坏」。\
         请改用带 V8 兼容通道的引擎包（QQ 目录中含 winmm.dll / snowcat-boot.js / napcat.mjs），\
         或在设置里把「QQ NT 安装目录」指向一个受支持的 QQ 便携目录。"
    )))
}

/// 用本机真实 QQ 版本改写引擎的 `qqnt.json`。
///
/// NapCat 的挂起注入把 `resources/app/package.json` 重定向到这份补丁包；
/// 里面的 version 写旧了，QQ 会按旧客户端版本走登录，卡在二维码或版本不匹配。
fn write_dynamic_qqnt(dir: &Path, settings: &EngineSettings) -> AppResult<()> {
    let Some(qq_root) = detect_qq(settings) else {
        return Ok(());
    };
    let Some(version) = qq_installed_version(&qq_root) else {
        return Ok(());
    };
    let build = version.rsplit('-').next().unwrap_or(&version);
    let patch = json!({
        "name": "qq-chat",
        "verHash": "",
        "version": version,
        "linuxVersion": "",
        "linuxVerHash": "",
        "private": true,
        "description": "QQ",
        "productName": "QQ",
        "author": { "name": "Tencent", "email": "QQ-Team@tencent.com" },
        "homepage": "https://im.qq.com",
        "sideEffects": true,
        "bin": { "qd": "externals/devtools/cli/index.js" },
        "main": "./loadNapCat.js",
        "buildVersion": build,
        "isPureShell": true,
        "isByteCodeShell": true,
        "platform": "win32",
        "eleArch": "x64"
    });
    std::fs::write(dir.join("qqnt.json"), serde_json::to_string_pretty(&patch)?)?;
    Ok(())
}

/// 用户主动启动、应用启动、退出登录后重启：重置「已重试」标记。
pub fn start_fresh(
    app: AppHandle,
    engine: Arc<Engine>,
    settings: EngineSettings,
) -> AppResult<EngineStatus> {
    {
        let mut rt = engine.rt();
        rt.retried = false;
        rt.last_error.clear();
    }
    start(app, engine, settings)
}

pub fn start(
    app: AppHandle,
    engine: Arc<Engine>,
    settings: EngineSettings,
) -> AppResult<EngineStatus> {
    if settings.mode == "external" {
        return Err(AppError::msg(
            "当前是「连接已有 NapCat」模式，不需要启动内嵌引擎",
        ));
    }
    // 同一时刻只允许一个启动流程。第二个并发调用直接返回当前状态，
    // 由先到的那个负责拉起进程。
    let _start_guard = match engine.start_guard.try_lock() {
        Ok(guard) => guard,
        Err(_) => return Ok(engine.status(&settings)),
    };
    {
        let rt = engine.rt();
        if rt.pid.is_some()
            && matches!(
                rt.phase.as_str(),
                "starting" | "awaiting_scan" | "scanned" | "online"
            )
        {
            drop(rt);
            return Ok(engine.status(&settings));
        }
    }

    // 两条启动路径：
    //  - V8：QQ 便携目录里带 V8 代理 + 引导脚本 + napcat.mjs（新版 QQ 唯一可行）
    //  - NapCat：传统 shell loader，走 NapCatWinBootMain 挂起注入
    let v8 = v8_dir(&settings);
    let dir = match &v8 {
        Some(path) => path.clone(),
        None => resolve_dir(&settings).ok_or_else(|| {
            AppError::msg(
                "还没有引擎文件。点「一键准备」让 Sylk 自己装好，或指定一个已有的 NapCat 目录",
            )
        })?,
    };
    let entry = if v8.is_some() {
        dir.join("QQ.exe")
    } else {
        entrypoint(&dir).ok_or_else(|| {
            AppError::msg("引擎目录里没有可执行入口，可能解压不完整。点「修复引擎」重试")
        })?
    };

    engine.set_phase("preparing", "正在准备引擎…");
    {
        let mut rt = engine.rt();
        rt.napcat_dir = dir.to_string_lossy().to_string();
        rt.mode = if v8.is_some() {
            "embedded-v8".into()
        } else {
            "embedded".into()
        };
        rt.qq_dir = if v8.is_some() {
            dir.to_string_lossy().to_string()
        } else {
            detect_qq(&settings)
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default()
        };
    }
    emit(&app, &engine, &settings);

    // 任何一步失败都要落成 error 状态：否则界面会永远停在「正在准备引擎」，
    // 用户既没有重试入口也看不到原因。
    let result = start_steps(
        app.clone(),
        engine.clone(),
        settings.clone(),
        dir,
        entry,
        v8.is_some(),
    );
    if let Err(err) = &result {
        let mut rt = engine.rt();
        rt.phase = "error".into();
        rt.detail = format!("引擎启动失败：{err}");
        rt.last_error = rt.detail.clone();
        rt.pid = None;
        rt.http_port = 0;
        rt.ws_port = 0;
        rt.started_at = 0;
        drop(rt);
        engine.epoch.fetch_add(1, Ordering::SeqCst);
        emit(&app, &engine, &settings);
    }
    result
}

fn start_steps(
    app: AppHandle,
    engine: Arc<Engine>,
    settings: EngineSettings,
    dir: PathBuf,
    entry: PathBuf,
    v8: bool,
) -> AppResult<EngineStatus> {
    if !v8 {
        check_qq_compat(&dir, &settings)?;
        write_dynamic_qqnt(&dir, &settings)?;
    } else {
        // V8 引擎包的 QQ 数据目录：NapCat 用它隔离自己的内核数据，
        // 不建出来时 QQ 内核初始化回调可能不触发（表现为永远没有二维码）。
        std::fs::create_dir_all(dir.join("qqdata"))?;
    }

    reap_orphan(&dir, &engine);

    let (http_port, ws_port) = reserve_ports()?;
    let token = random_token();
    write_configs(&dir, http_port, ws_port, &token)?;
    engine.log(format!(
        "配置已写入 · HTTP {http_port} · WS {ws_port} · {}",
        if v8 {
            "V8 兼容通道"
        } else {
            "NapCat 注入"
        }
    ));

    let mut child = if v8 {
        spawn_v8(&dir)?
    } else {
        spawn_process(&dir, &entry, &settings)?
    };
    let pid = child.id();
    engine.log(format!("引擎已拉起 · PID {pid} · {}", entry.display()));

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    {
        let mut guard = engine.child.lock().unwrap_or_else(|err| err.into_inner());
        *guard = Some(child);
    }

    {
        let mut rt = engine.rt();
        rt.http_port = http_port;
        rt.ws_port = ws_port;
        rt.token = token;
        rt.pid = Some(pid);
        rt.qr_version += 1;
        rt.started_at = chrono::Local::now().timestamp();
        rt.account = None;
        rt.phase = "starting".into();
        rt.detail = "引擎启动中…".into();
    }
    write_pid(&dir, pid);
    *engine.qr.lock().unwrap_or_else(|err| err.into_inner()) = None;
    engine.epoch.fetch_add(1, Ordering::SeqCst);
    emit(&app, &engine, &settings);

    if let Some(out) = stdout {
        spawn_reader(app.clone(), engine.clone(), settings.clone(), out, false);
    }
    if let Some(err) = stderr {
        spawn_reader(app.clone(), engine.clone(), settings.clone(), err, true);
    }

    let status = engine.status(&settings);
    spawn_qr_watcher(app.clone(), engine.clone(), settings.clone(), dir.clone());
    spawn_watchdog(app, engine.clone(), settings, pid);

    Ok(status)
}

fn spawn_reader<R: Read + Send + 'static>(
    app: AppHandle,
    engine: Arc<Engine>,
    settings: EngineSettings,
    stream: R,
    is_stderr: bool,
) {
    std::thread::spawn(move || {
        let reader = BufReader::new(stream);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let text = line.trim().to_string();
            if text.is_empty() {
                continue;
            }
            // 引擎日志会带 WebUI 令牌、加载路径和本机用户名；进 UI 前先脱敏。
            let token = engine.rt().token.clone();
            let mut text = crate::privacy::redact_line(&text);
            if !token.is_empty() {
                text = text.replace(&token, "***");
            }
            if is_stderr {
                engine.log(format!("! {text}"));
            } else {
                engine.log(text.clone());
            }
            apply_stage(&app, &engine, &settings, &text);
        }
    });
}

/// 日志只用来推进「过程感」，真正的在线判断交给 watchdog 的接口探测。
fn apply_stage(app: &AppHandle, engine: &Engine, settings: &EngineSettings, line: &str) {
    let changed = {
        let lowered = line.to_lowercase();
        let mut rt = engine.rt();
        let mut changed = false;

        let set = |rt: &mut Runtime, phase: &str, detail: &str| -> bool {
            if rt.phase == phase {
                return false;
            }
            rt.phase = phase.into();
            rt.detail = detail.into();
            true
        };

        if lowered.contains("webui") && lowered.contains("url") {
            changed |= set(&mut rt, "starting", "管理服务已就绪，正在登录 QQ…");
        }
        if line.contains("二维码已保存") || line.contains("请扫描下面的二维码") {
            rt.qr_version += 1;
            changed |= set(&mut rt, "awaiting_scan", "用手机 QQ 扫描二维码完成登录");
        }
        if line.contains("二维码已被扫描") {
            changed |= set(&mut rt, "scanned", "已扫码，请在手机上确认登录");
        }
        if line.contains("登录成功") || line.contains("账号已上线") {
            changed |= set(&mut rt, "online", "登录成功，正在同步会话");
        }
        if lowered.contains("adapter") && (line.contains("初始化完成") || line.contains("已加载"))
        {
            changed |= set(&mut rt, "starting", "协议适配器已就绪");
        }
        changed
    };

    if changed {
        emit(app, engine, settings);
    }
}

fn spawn_qr_watcher(app: AppHandle, engine: Arc<Engine>, settings: EngineSettings, dir: PathBuf) {
    tauri::async_runtime::spawn(async move {
        let mut last_stamp: Option<(u64, u64)> = None;
        loop {
            {
                let rt = engine.rt();
                if rt.pid.is_none() {
                    break;
                }
            }
            if let Some(path) = find_qrcode(&dir) {
                if let Ok(meta) = std::fs::metadata(&path) {
                    // QQ 的登录二维码有效期约两分钟，且 NapCat 不会自己换图。
                    // 这里刻意不自动重启：每多一次自动登录尝试就多一次触发腾讯风控的
                    // 风险（「当前扫码操作存在安全风险」就是这么来的）。
                    // 过期时只清掉旧图并提示，由用户点「刷新二维码」发起一次新尝试。
                    let expired = meta
                        .modified()
                        .ok()
                        .and_then(|time| time.elapsed().ok())
                        .map(|age| age > Duration::from_secs(105))
                        .unwrap_or(false);
                    if expired && engine.rt().phase == "awaiting_scan" {
                        engine.log("二维码已过期，等待用户手动刷新");
                        let _ = std::fs::remove_file(&path);
                        *engine.qr.lock().unwrap_or_else(|err| err.into_inner()) = None;
                        let mut rt = engine.rt();
                        rt.qr_version = rt.qr_version.wrapping_add(1);
                        rt.detail = "二维码已过期，点「刷新二维码」重新生成".into();
                        drop(rt);
                        emit(&app, &engine, &settings);
                    }
                    let stamp = (
                        meta.len(),
                        meta.modified()
                            .ok()
                            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                            .map(|dur| dur.as_millis() as u64)
                            .unwrap_or(0),
                    );
                    if Some(stamp) != last_stamp {
                        if let Ok(bytes) = std::fs::read(&path) {
                            if !bytes.is_empty() {
                                *engine.qr.lock().unwrap_or_else(|err| err.into_inner()) =
                                    Some(bytes);
                                let mut rt = engine.rt();
                                rt.qr_version = rt.qr_version.wrapping_add(1);
                                if rt.phase == "starting" {
                                    rt.phase = "awaiting_scan".into();
                                    rt.detail = "用手机 QQ 扫描二维码完成登录".into();
                                }
                                drop(rt);
                                last_stamp = Some(stamp);
                                emit(&app, &engine, &settings);
                            }
                        }
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(700)).await;
        }
    });
}

fn spawn_watchdog(app: AppHandle, engine: Arc<Engine>, settings: EngineSettings, pid: u32) {
    tauri::async_runtime::spawn(async move {
        let mut misses = 0u32;
        let started = Instant::now();
        loop {
            tokio::time::sleep(Duration::from_millis(2000)).await;

            // 被主动停止（pid 被清掉）就安静退出，不要报成崩溃
            if engine.rt().pid != Some(pid) {
                return;
            }

            // 进程还在吗
            let exited = {
                let mut guard = engine.child.lock().unwrap_or_else(|err| err.into_inner());
                match guard.as_mut() {
                    Some(child) => match child.try_wait() {
                        Ok(Some(status)) => Some(status.code().unwrap_or(-1)),
                        Ok(None) => None,
                        Err(_) => Some(-1),
                    },
                    None => Some(-1),
                }
            };

            if let Some(code) = exited {
                let dir = engine.rt().napcat_dir.clone();
                if !dir.is_empty() {
                    clear_pid(Path::new(&dir));
                }
                let uptime = engine.rt().started_at;
                let uptime_secs = if uptime > 0 {
                    chrono::Local::now().timestamp() - uptime
                } else {
                    0
                };
                let retried = engine.rt().retried;

                {
                    let mut rt = engine.rt();
                    rt.pid = None;
                    rt.started_at = 0;
                }
                engine.log(format!("引擎退出，代码 {code}，运行了 {uptime_secs} 秒"));

                // 起来不到 12 秒就退，最常见的原因是端口被上一个实例占着（热重载、崩溃重启）。
                // 换一组端口自动再试一次，失败才报错给用户。
                if uptime_secs < 12 && !retried {
                    engine.rt().retried = true;
                    engine.log("疑似端口被占，换一组端口重试");
                    engine.epoch.fetch_add(1, Ordering::SeqCst);
                    match start(app.clone(), engine.clone(), settings.clone()) {
                        Ok(_) => return,
                        Err(err) => engine.log(format!("重试失败：{err}")),
                    }
                }

                let mut rt = engine.rt();
                rt.phase = "error".into();
                rt.detail = if qq_running() {
                    "QQ 正在运行。引擎需要自己启动 QQ，请先完全退出 QQ（包括托盘图标），再重试。"
                        .to_string()
                } else {
                    format!("引擎已退出（代码 {code}）。可以点「重启引擎」再试一次。")
                };
                rt.last_error = rt.detail.clone();
                drop(rt);
                engine.epoch.fetch_add(1, Ordering::SeqCst);
                emit(&app, &engine, &settings);
                return;
            }

            // 引导进程活着，但端口迟迟不监听：注入后 QQ 直接崩掉、或引擎卡死。
            // 判定失败前必须把进程树收掉，否则之后「停止 / 重启 / 退出」会一直
            // 等在还活着的子进程上，整个应用退不掉。
            if started.elapsed() > Duration::from_secs(75) && engine.rt().phase == "starting" {
                let detail = match (
                    resolve_dir(&settings).and_then(|dir| bundled_qq_version(&dir)),
                    installed_qq_version(&settings),
                ) {
                    (Some(engine_ver), Some(qq_ver)) if engine_ver != qq_ver => format!(
                        "引擎包适配 QQ {engine_ver}，本机是 {qq_ver}。两者必须一致，否则注入会让 QQ 直接退出。"
                    ),
                    _ => {
                        if qq_running() {
                            "QQ 正在运行，引擎需要自己启动 QQ。请先完全退出 QQ（包括托盘图标）再重试。".to_string()
                        } else {
                            "引擎在 75 秒内没有就绪。点「重启引擎」再试一次；仍失败可在设置里查看引擎日志。".to_string()
                        }
                    }
                };
                let dir = engine.rt().napcat_dir.clone();
                {
                    let mut rt = engine.rt();
                    rt.phase = "error".into();
                    rt.detail = detail.clone();
                    rt.last_error = detail;
                    rt.pid = None;
                    rt.http_port = 0;
                    rt.ws_port = 0;
                    rt.started_at = 0;
                }
                kill_tree(pid);
                if !dir.is_empty() {
                    clear_pid(Path::new(&dir));
                }
                if let Some(mut child) = engine
                    .child
                    .lock()
                    .unwrap_or_else(|err| err.into_inner())
                    .take()
                {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                engine.log("超时未就绪，已判定为失败并清理进程");
                engine.epoch.fetch_add(1, Ordering::SeqCst);
                emit(&app, &engine, &settings);
                return;
            }

            // 接口探活
            let endpoints = engine.endpoints();
            let Some((base, _, token)) = endpoints else {
                continue;
            };
            let client = NapcatClient::new(&base, &token, crate::pipeline::http_client());
            match client.login_info().await {
                Ok(account) => {
                    misses = 0;
                    let mut rt = engine.rt();
                    let was_online = rt.phase == "online";
                    rt.account = Some(account.clone());
                    let dir = rt.napcat_dir.clone();
                    if !was_online {
                        rt.phase = "online".into();
                        rt.detail = format!("已登录 {}（{}）", account.nickname, account.uin);
                    }
                    drop(rt);
                    if !was_online {
                        // 记下账号：下次启动带 -q 走快速登录，用户不必每次扫码。
                        if !dir.is_empty() {
                            let _ = std::fs::write(
                                Path::new(&dir).join(".sylk-account"),
                                account.uin.as_str(),
                            );
                        }
                        engine.log(format!(
                            "登录成功 · {}（{}）",
                            account.nickname,
                            crate::privacy::mask_uin(&account.uin)
                        ));
                        engine.epoch.fetch_add(1, Ordering::SeqCst);
                        let _ = app.emit(EV_ENGINE, engine.status(&settings));
                        let _ = app.emit(
                            "sylk://engine-ready",
                            json!({ "uin": account.uin, "nickname": account.nickname }),
                        );
                    }
                }
                Err(_) => {
                    misses += 1;
                    // 启动 90 秒还没通，多半是 QQ 没装或版本不匹配，给出可执行的提示。
                    if misses > 45 && started.elapsed() > Duration::from_secs(90) {
                        let mut rt = engine.rt();
                        if rt.phase == "starting" {
                            rt.detail =
                                "引擎起来了但接口没有响应，通常是本机没有安装 QQ NT。可以点「检查环境」。"
                                    .into();
                        }
                        drop(rt);
                    }
                }
            }
            let _ = pid;
        }
    });
}

pub fn stop(app: &AppHandle, engine: &Engine, settings: &EngineSettings) {
    let pid = {
        let mut rt = engine.rt();
        let pid = rt.pid;
        rt.pid = None;
        rt.started_at = 0;
        rt.http_port = 0;
        rt.ws_port = 0;
        rt.qr_version += 1;
        if rt.phase != "error" {
            rt.phase = "stopped".into();
            rt.detail = "引擎已停止".into();
        }
        pid
    };

    if let Some(pid) = pid {
        kill_tree(pid);
        engine.log(format!("已停止引擎 · PID {pid}"));
    }
    {
        let mut guard = engine.child.lock().unwrap_or_else(|err| err.into_inner());
        if let Some(mut child) = guard.take() {
            // pid 已经被 watchdog 清掉（比如超时判定）时，child 可能还活着。
            // 先 kill 再 wait，避免在这里永久阻塞。
            let child_pid = child.id();
            kill_tree(child_pid);
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    let dir = engine.rt().napcat_dir.clone();
    if !dir.is_empty() {
        clear_pid(Path::new(&dir));
    }
    *engine.qr.lock().unwrap_or_else(|err| err.into_inner()) = None;
    engine.epoch.fetch_add(1, Ordering::SeqCst);
    emit(app, engine, settings);
}

/// 退出登录：停掉引擎、清掉二维码与登录缓存，再拉起来要求重新扫码。
pub fn logout(
    app: &AppHandle,
    engine: Arc<Engine>,
    settings: &EngineSettings,
) -> AppResult<EngineStatus> {
    let dir = engine.rt().napcat_dir.clone();
    if dir.is_empty() {
        return Err(AppError::msg("引擎目录未知，无法退出登录"));
    }
    stop(app, &engine, settings);

    if let Some(qr) = find_qrcode(Path::new(&dir)) {
        let _ = std::fs::remove_file(qr);
    }
    // 清掉快速登录标记与引擎自己保存的 QQ 数据目录，才能真正换号。
    // 经典注入把登录态放在 <dir>/data；V8 模式通过 NAPCAT_QQ_DATA_DIR 放在 <dir>/qqdata。
    let _ = std::fs::remove_file(Path::new(&dir).join(".sylk-account"));
    for name in ["data", "qqdata"] {
        let data = Path::new(&dir).join(name);
        if data.is_dir() {
            let _ = std::fs::remove_dir_all(&data);
        }
    }

    start_fresh(app.clone(), engine, settings.clone())
}

pub fn qrcode(engine: &Engine) -> Option<(u64, Vec<u8>)> {
    let version = engine.rt().qr_version;
    let bytes = engine
        .qr
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .clone()?;
    Some((version, bytes))
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_hex_and_long_enough() {
        let token = random_token();
        assert_eq!(token.len(), 24);
        assert!(token.chars().all(|ch| ch.is_ascii_hexdigit()));
        assert_ne!(token, random_token());
    }

    #[test]
    fn ports_differ() {
        for _ in 0..5 {
            let (http, ws) = reserve_ports().unwrap();
            assert_ne!(http, ws);
            assert!(http > 1024);
        }
    }

    #[test]
    fn writes_loopback_only_configs() {
        let dir = std::env::temp_dir().join("sylk-engine-config-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        write_configs(&dir, 13_700, 13_701, "abc123").unwrap();

        let raw = std::fs::read_to_string(dir.join("config").join("onebot11.json")).unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let http = &value["network"]["httpServers"][0];
        assert_eq!(http["host"], "127.0.0.1");
        assert_eq!(http["port"], 13_700);
        assert_eq!(http["token"], "abc123");
        let ws = &value["network"]["websocketServers"][0];
        assert_eq!(ws["host"], "127.0.0.1");
        assert_eq!(ws["port"], 13_701);

        let webui: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join("config").join("webui.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(webui["host"], "127.0.0.1");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn detects_entrypoint_in_nested_dir() {
        let dir = std::env::temp_dir().join("sylk-engine-entry-test");
        let nested = dir.join("NapCat.12345.Shell");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(nested.join("napcat.bat"), "echo hi").unwrap();
        let found = entrypoint(&dir).unwrap();
        assert!(found.ends_with("napcat.bat"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
