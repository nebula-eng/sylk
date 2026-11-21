//! 隐私与本地数据保护。
//!
//! Sylk 的全部数据都在这台机器上：数据库、录音、转写文本、引擎登录态，
//! 以及引擎与云端转写用到的访问令牌。这一层负责把它们在磁盘和日志里
//! 收拾到可接受的状态：
//!
//! - **密钥不裸存**：云端转写的 API Key 用 Windows DPAPI 按当前用户加密，
//!   只有同一账户能解开；设置页仍然能看到明文（这是编辑所需），但磁盘上不是。
//! - **日志可公开**：引擎与后端日志在进入界面前做脱敏（令牌、用户目录路径、
//!   QQ 号中间位）。日志按天落盘，超过保留期的自动清掉。
//! - **按需清理**：`retainDays` 控制语音/转写/任务的自动过期；「清除本机数据」
//!   把数据库、媒体文件、引擎登录态和日志一并清掉，只留程序和你的设置。
//! - **截屏防护**：可选让系统截屏/录屏工具捕获不到 Sylk 窗口（Windows 10 2004+）。
//! - **出站白名单**：用户填写的下载地址与云端转写地址必须走 HTTPS（本机回环除外），
//!   防止把引擎包或音频发到明文通道。
//!
//! 这一层不处理账号本身的安全：NapCat 与 QQ 是第三方依赖，登录态是否安全取决于
//! 它们和你的系统账户。边界写在 `SECURITY.md`。

use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::config::Paths;
use crate::db;
use crate::error::{AppError, AppResult};
use crate::state::Inner;

const SECRET_PREFIX: &str = "dpapi:";
const LOG_RETENTION_DAYS: u64 = 14;

// ---------------------------------------------------------------------------
// 随机数
// ---------------------------------------------------------------------------

/// 生成加密安全随机 hex 字符串（引擎端口令牌用）。
/// `uuid::Uuid::new_v4()` 底层是操作系统的 CSPRNG，比拿时间戳哈希可靠得多。
pub fn random_hex(len: usize) -> String {
    let mut out = String::with_capacity(len);
    while out.len() < len {
        out.push_str(&uuid::Uuid::new_v4().simple().to_string());
    }
    out.truncate(len);
    out
}

// ---------------------------------------------------------------------------
// 密钥保护（Windows DPAPI）
// ---------------------------------------------------------------------------

pub fn is_protected_secret(value: &str) -> bool {
    value.starts_with(SECRET_PREFIX)
}

/// 加密一个密钥。空值直接返回；非 Windows 或无 DPAPI 时退回明文并在日志里说明。
pub fn protect_secret(plain: &str) -> String {
    let plain = plain.trim();
    if plain.is_empty() || is_protected_secret(plain) {
        return plain.to_string();
    }
    #[cfg(windows)]
    {
        if let Some(cipher) = dpapi_protect(plain.as_bytes()) {
            use base64::Engine as _;
            return format!(
                "{SECRET_PREFIX}{}",
                base64::engine::general_purpose::STANDARD.encode(cipher)
            );
        }
        tracing::warn!("DPAPI 加密失败，密钥将以明文保存");
    }
    plain.to_string()
}

/// 解密一个密钥；对历史明文值原样返回，方便平滑迁移。
pub fn unprotect_secret(stored: &str) -> String {
    if !is_protected_secret(stored) {
        return stored.to_string();
    }
    #[cfg(windows)]
    {
        use base64::Engine as _;
        let raw = &stored[SECRET_PREFIX.len()..];
        if let Ok(cipher) = base64::engine::general_purpose::STANDARD.decode(raw) {
            if let Some(plain) = dpapi_unprotect(&cipher) {
                if let Ok(text) = String::from_utf8(plain) {
                    return text;
                }
            }
        }
        tracing::warn!("DPAPI 解密失败（可能换过 Windows 账户），已忽略保存的密钥");
    }
    String::new()
}

#[cfg(windows)]
fn dpapi_protect(plain: &[u8]) -> Option<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    unsafe {
        let input = CRYPT_INTEGER_BLOB {
            cbData: plain.len() as u32,
            pbData: plain.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        let ok = CryptProtectData(
            &input,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        );
        if ok == 0 || output.pbData.is_null() {
            return None;
        }
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as *mut core::ffi::c_void);
        Some(bytes)
    }
}

#[cfg(windows)]
fn dpapi_unprotect(cipher: &[u8]) -> Option<Vec<u8>> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    unsafe {
        let input = CRYPT_INTEGER_BLOB {
            cbData: cipher.len() as u32,
            pbData: cipher.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        let ok = CryptUnprotectData(
            &input,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        );
        if ok == 0 || output.pbData.is_null() {
            return None;
        }
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        LocalFree(output.pbData as *mut core::ffi::c_void);
        Some(bytes)
    }
}

// ---------------------------------------------------------------------------
// 日志脱敏
// ---------------------------------------------------------------------------

/// 把 QQ 号中间位遮掉：123456789 -> 123****789。
pub fn mask_uin(uin: &str) -> String {
    let chars: Vec<char> = uin.chars().collect();
    if chars.len() <= 6 {
        return "*".repeat(chars.len());
    }
    format!(
        "{}****{}",
        chars[..3].iter().collect::<String>(),
        chars[chars.len() - 3..].iter().collect::<String>()
    )
}

/// 日志单行脱敏：访问令牌、Bearer 令牌、Windows 用户目录。
pub fn redact_line(line: &str) -> String {
    let mut text = mask_query_value(line, "access_token=");
    text = mask_query_value(&text, "token=");
    text = mask_after_prefix(&text, "Bearer ");
    mask_user_dir(&text)
}

fn mask_query_value(line: &str, key: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(index) = rest.find(key) {
        let value_start = index + key.len();
        out.push_str(&rest[..value_start]);
        let tail = &rest[value_start..];
        let end = tail
            .find(['&', '"', '\'', ' ', '\t', '\r', '\n'])
            .unwrap_or(tail.len());
        let value = &tail[..end];
        // 只遮看起来像令牌的值，避免把普通文本里的 token= 也吃掉。
        if value.len() >= 8 {
            out.push_str("***");
        } else {
            out.push_str(value);
        }
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}

fn mask_after_prefix(line: &str, prefix: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(index) = rest.find(prefix) {
        let value_start = index + prefix.len();
        out.push_str(&rest[..value_start]);
        let tail = &rest[value_start..];
        let end = tail
            .find(['"', '\'', ' ', '\t', '\r', '\n'])
            .unwrap_or(tail.len());
        if end >= 8 {
            out.push_str("***");
        } else {
            out.push_str(&tail[..end]);
        }
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}

fn mask_user_dir(line: &str) -> String {
    let mut text = line.to_string();
    for drive in ["C:", "D:", "E:", "F:"] {
        let prefix = format!("{drive}\\Users\\");
        let mut search_from = 0usize;
        while let Some(index) = text[search_from..].find(&prefix) {
            let start = search_from + index + prefix.len();
            let Some(len) = text[start..].find('\\') else {
                break;
            };
            if len == 0 || &text[start..start + len] == "***" {
                search_from = start + len;
                continue;
            }
            text.replace_range(start..start + len, "***");
            search_from = start + 3;
        }
    }
    text
}

// ---------------------------------------------------------------------------
// 出站地址校验
// ---------------------------------------------------------------------------

/// 用户填写的远程地址必须是 HTTPS；本机回环允许 http（本地服务常见）。
/// 用于引擎下载地址与 OpenAI 兼容转写接口。
pub fn validate_remote_url(url: &str, label: &str) -> AppResult<()> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return Err(AppError::msg(format!("{label}不能为空")));
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("https://") {
        return Ok(());
    }
    if let Some(rest) = lower.strip_prefix("http://") {
        let host = rest.split(['/', ':', '?', '#']).next().unwrap_or("");
        if is_loopback_host(host) {
            return Ok(());
        }
        return Err(AppError::msg(format!(
            "{label}必须使用 HTTPS；只有本机回环地址（127.0.0.1 / localhost）允许 http"
        )));
    }
    Err(AppError::msg(format!(
        "{label}必须以 https:// 或 http://127.0.0.1 开头"
    )))
}

fn is_loopback_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1")
        || host
            .strip_prefix("127.")
            .map(|rest| rest.chars().all(|ch| ch.is_ascii_digit() || ch == '.'))
            .unwrap_or(false)
}

// ---------------------------------------------------------------------------
// 路径边界
// ---------------------------------------------------------------------------

/// 校验目标路径确实位于 root 之内，防止数据库/配置被篡改后越界读写。
pub fn ensure_under(root: &Path, candidate: &Path) -> AppResult<PathBuf> {
    let root = root
        .canonicalize()
        .map_err(|err| AppError::msg(format!("根目录不可用：{err}")))?;
    let resolved = match candidate.canonicalize() {
        Ok(path) => path,
        Err(_) => match candidate.parent() {
            Some(parent) => match parent.canonicalize() {
                Ok(parent) => {
                    parent.join(candidate.file_name().map(PathBuf::from).unwrap_or_default())
                }
                Err(_) => candidate.to_path_buf(),
            },
            None => candidate.to_path_buf(),
        },
    };
    if resolved.starts_with(&root) {
        Ok(resolved)
    } else {
        Err(AppError::msg("文件路径不在媒体库目录内，已拒绝访问"))
    }
}

// ---------------------------------------------------------------------------
// 截屏防护
// ---------------------------------------------------------------------------

/// Windows 10 2004+ 支持把窗口从截屏/录屏里排除。
#[cfg(windows)]
pub fn apply_capture_protection(window: &tauri::WebviewWindow, enabled: bool) -> AppResult<()> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_NONE,
    };
    let hwnd = window
        .hwnd()
        .map_err(|err| AppError::msg(format!("取窗口句柄失败：{err}")))?;
    let raw = hwnd.0 as isize as *mut core::ffi::c_void;
    let affinity = if enabled {
        WDA_EXCLUDEFROMCAPTURE
    } else {
        WDA_NONE
    };
    let ok = unsafe { SetWindowDisplayAffinity(raw, affinity) };
    if ok == 0 {
        return Err(AppError::msg(
            "当前 Windows 版本不支持窗口截屏防护（需要 Windows 10 2004 及以上）",
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn apply_capture_protection(_window: &tauri::WebviewWindow, _enabled: bool) -> AppResult<()> {
    Err(AppError::msg("当前平台不支持窗口截屏防护"))
}

pub fn apply_capture_for(app: &AppHandle, enabled: bool) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if let Err(err) = apply_capture_protection(&window, enabled) {
        tracing::warn!("截屏防护设置失败：{err}");
    }
}

// ---------------------------------------------------------------------------
// 保留期清理
// ---------------------------------------------------------------------------

/// 按 `privacy.retainDays` 清理过期语音（数据库行、任务与本地文件）。
/// 返回删除的语音条数。
pub fn purge_expired(app: &AppHandle, state: &Inner) -> AppResult<u64> {
    let settings = state.settings_snapshot();
    let days = settings.privacy.retain_days as i64;
    if days <= 0 {
        return Ok(0);
    }
    let cutoff = chrono::Local::now().timestamp() - days * 86_400;
    let library = PathBuf::from(&settings.library_dir);

    let rows: Vec<(i64, String, String)> = {
        let conn = state.db();
        let mut stmt =
            conn.prepare("SELECT id, file_path, raw_path FROM voices WHERE sent_at < ?1")?;
        let mapped = stmt.query_map([cutoff], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        mapped.collect::<Result<Vec<_>, _>>()?
    };
    if rows.is_empty() {
        return Ok(0);
    }

    let mut removed = 0u64;
    for (id, file_path, raw_path) in rows {
        for path in [file_path, raw_path] {
            if path.is_empty() {
                continue;
            }
            if let Ok(safe) = ensure_under(&library, Path::new(&path)) {
                let _ = std::fs::remove_file(safe);
            }
        }
        let conn = state.db();
        if db::delete_voice(&conn, id).is_ok() {
            removed += 1;
        }
    }
    let _ = app.emit(
        crate::state::EV_VOICES,
        serde_json::json!({ "reason": "retention" }),
    );
    let _ = app.emit(crate::state::EV_JOBS, serde_json::json!({}));
    Ok(removed)
}

// ---------------------------------------------------------------------------
// 数据统计与清除
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrivacyStats {
    pub accounts: i64,
    pub conversations: i64,
    pub voices: i64,
    pub library_bytes: i64,
    pub log_bytes: i64,
    pub engine_bytes: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WipeReport {
    pub voices: i64,
    pub files: i64,
    pub bytes: i64,
}

fn dir_size(root: &Path) -> (i64, i64) {
    fn walk(dir: &Path, files: &mut i64, bytes: &mut i64) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, files, bytes);
            } else if let Ok(meta) = entry.metadata() {
                *files += 1;
                *bytes += meta.len() as i64;
            }
        }
    }
    let (mut files, mut bytes) = (0, 0);
    walk(root, &mut files, &mut bytes);
    (files, bytes)
}

/// 引擎侧的个人数据目录：登录态与引擎缓存，不含引擎程序本身。
fn engine_data_dirs(state: &Inner) -> Vec<PathBuf> {
    let settings = state.settings_snapshot();
    let mut roots = Vec::new();
    if let Some(dir) = crate::engine::v8_dir(&settings.engine) {
        roots.push(dir);
    } else if let Some(dir) = crate::engine::resolve_dir(&settings.engine) {
        roots.push(dir);
    }
    let mut dirs = Vec::new();
    for root in roots {
        for name in ["qqdata", "data", "cache", "logs", "NapCat"] {
            let path = root.join(name);
            if path.exists() {
                dirs.push(path);
            }
        }
    }
    dirs
}

fn engine_files(state: &Inner) -> Vec<PathBuf> {
    let settings = state.settings_snapshot();
    let mut roots = Vec::new();
    if let Some(dir) = crate::engine::v8_dir(&settings.engine) {
        roots.push(dir);
    } else if let Some(dir) = crate::engine::resolve_dir(&settings.engine) {
        roots.push(dir);
    }
    let mut files = Vec::new();
    for root in roots {
        for name in [".sylk-account", ".sylk-engine.pid", "nc-boot.log"] {
            let path = root.join(name);
            if path.is_file() {
                files.push(path);
            }
        }
        let config = root.join("config");
        if let Ok(entries) = std::fs::read_dir(&config) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with("napcat_") || name.starts_with("onebot11_") {
                    files.push(entry.path());
                }
            }
        }
    }
    files
}

pub fn stats(state: &Inner) -> PrivacyStats {
    let settings = state.settings_snapshot();
    let (accounts, conversations, voices) = {
        let conn = state.db();
        let count = |table: &str| -> i64 {
            conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap_or(0)
        };
        (count("accounts"), count("conversations"), count("voices"))
    };
    let (_, library_bytes) = dir_size(Path::new(&settings.library_dir));
    let paths: Paths = state.paths.clone();
    let (_, log_bytes) = dir_size(&paths.log_dir);
    let engine_bytes = engine_data_dirs(state)
        .iter()
        .map(|dir| dir_size(dir).1)
        .sum();
    PrivacyStats {
        accounts,
        conversations,
        voices,
        library_bytes,
        log_bytes,
        engine_bytes,
    }
}

/// 清除本机数据：数据库记录、媒体文件、引擎登录态与日志。
/// 保留程序本身与设置（引擎路径、媒体库位置、转写配置）。
pub fn wipe_all(app: &AppHandle, state: &Inner) -> AppResult<WipeReport> {
    let settings = state.settings_snapshot();
    crate::engine::stop(app, &state.engine, &settings.engine);

    // 1) 先删文件，再删数据库：即使中途失败，也不会留下「索引没了、文件还在」的错觉。
    let library = PathBuf::from(&settings.library_dir);
    let mut files = 0i64;
    let mut bytes = 0i64;
    for name in ["audio", "raw", "exports"] {
        let dir = library.join(name);
        if dir.exists() {
            let (f, b) = dir_size(&dir);
            files += f;
            bytes += b;
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
    for dir in engine_data_dirs(state) {
        let (f, b) = dir_size(&dir);
        files += f;
        bytes += b;
        let _ = std::fs::remove_dir_all(&dir);
    }
    for file in engine_files(state) {
        if let Ok(meta) = std::fs::metadata(&file) {
            bytes += meta.len() as i64;
        }
        if std::fs::remove_file(&file).is_ok() {
            files += 1;
        }
    }
    if let Ok(entries) = std::fs::read_dir(&state.paths.log_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() && std::fs::remove_file(&path).is_ok() {
                files += 1;
            }
        }
    }

    // 2) 数据库：账号、会话、语音、任务全部清掉，并回收空间。
    let voices = {
        let conn = state.db();
        let voices: i64 = conn
            .query_row("SELECT COUNT(*) FROM voices", [], |row| row.get(0))
            .unwrap_or(0);
        conn.execute_batch(
            "DELETE FROM jobs;
             DELETE FROM voices;
             DELETE FROM conversations;
             DELETE FROM accounts;
             VACUUM;",
        )?;
        voices
    };

    // 3) 运行状态回到「没有账号」。
    state.set_account(None);
    let mut connection = state.connection();
    connection.status = "idle".into();
    connection.message = "本机数据已清除".into();
    connection.account = None;
    connection.live = false;
    state.set_connection(app, connection);
    {
        let mut rt = state.engine.rt();
        rt.account = None;
        rt.qr_version = rt.qr_version.wrapping_add(1);
    }
    let _ = app.emit(
        crate::state::EV_VOICES,
        serde_json::json!({ "reason": "wiped" }),
    );
    let _ = app.emit(crate::state::EV_JOBS, serde_json::json!({}));
    crate::engine::emit(app, &state.engine, &settings.engine);

    Ok(WipeReport {
        voices,
        files,
        bytes,
    })
}

/// 清理过期日志文件（保留最近 `LOG_RETENTION_DAYS` 天）。
pub fn prune_logs(state: &Inner) {
    let cutoff = SystemTime::now()
        .checked_sub(std::time::Duration::from_secs(LOG_RETENTION_DAYS * 86_400))
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|dur| dur.as_secs())
        .unwrap_or(0);
    let Ok(entries) = std::fs::read_dir(&state.paths.log_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let modified = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|dur| dur.as_secs())
            .unwrap_or(u64::MAX);
        if modified < cutoff {
            let _ = std::fs::remove_file(path);
        }
    }
}
