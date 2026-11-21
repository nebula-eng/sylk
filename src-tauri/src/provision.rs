//! 引擎获取：让「安装 NapCat」这一步从用户的待办里消失。
//!
//! 优先级从高到低：
//! 0. 构建时打进了引擎包 → 直接本地解压，全程不联网
//! 1. 已经有完整引擎 → 直接用
//! 2. 用户指定了一个现成的 NapCat 目录 → 直接采用，不动它的文件
//! 3. 用户给了一个压缩包 → 解压到引擎目录
//! 4. 从内置候选地址下载 → 解压 → 校验
//!
//! 四条路都不通时返回一句能照着做的话，而不是一个错误码。

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::engine;
use crate::error::{AppError, AppResult};
use crate::models::EngineSettings;

/// 官方发布渠道。GitHub 的 releases 接口近几年时有时无，
/// 所以这里按可能性排序，逐个试；用户也可以在设置里覆盖。
const CANDIDATES: &[&str] = &[
    "https://github.com/NapNeko/NapCatQQ/releases/latest/download/NapCat.Shell.zip",
    "https://napneko.icu/download/NapCat.Shell.zip",
];

/// 下载与解压的上限。超过就中止，避免被超大包或伪造头部的 zip 拖垮。
const MAX_DOWNLOAD_BYTES: u64 = 1_500 * 1024 * 1024;
const MAX_ZIP_ENTRIES: usize = 50_000;
const MAX_ZIP_ENTRY_BYTES: u64 = 512 * 1024 * 1024;
const MAX_ZIP_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;

fn emit_progress(app: &AppHandle, stage: &str, percent: u8, detail: &str) {
    let _ = app.emit(
        "sylk://engine-prepare",
        serde_json::json!({ "stage": stage, "percent": percent, "detail": detail }),
    );
}

/// 引擎是否已经可用（有目录且有入口）。
pub fn is_ready(settings: &EngineSettings) -> bool {
    engine::resolve_dir(settings)
        .and_then(|dir| engine::entrypoint(&dir))
        .is_some()
}

/// 采用一个已有的引擎目录：只校验，不搬动。
///
/// 两种布局都认：经典 NapCat 目录，以及 V8 兼容引擎包（便携 QQ + 兼容层）。
pub fn adopt(settings: &mut EngineSettings, dir: &str) -> AppResult<()> {
    let path = PathBuf::from(dir);
    if !path.is_dir() {
        return Err(AppError::msg(format!("目录不存在：{dir}")));
    }
    if let Some(bundle) = engine::v8_bundle_at(&path) {
        tracing::info!("采用兼容引擎包：{}", bundle.display());
        settings.qq_path = bundle.to_string_lossy().to_string();
        settings.napcat_dir.clear();
        return Ok(());
    }
    let entry = engine::entrypoint(&path).ok_or_else(|| {
        AppError::msg(
            "这个目录里找不到可用的引擎。\n\
             兼容引擎包需要同时含 QQ.exe / winmm.dll / snowcat-boot.js / napcat.mjs；\n\
             NapCat 目录需要 NapCatWinBootMain.exe / napcat.bat / napcat.mjs。",
        )
    })?;
    tracing::info!("采用已有引擎：{}", entry.display());
    settings.napcat_dir = path.to_string_lossy().to_string();
    Ok(())
}

/// 构建时打进安装包的引擎压缩包。
///
/// 引擎本体（NapCat 之类）没有可再分发的授权，所以仓库里不带，也不能替用户下载后
/// 打包分发。但每个人可以用自己的那份：构建时通过 `--engine=<zip>` 塞进 resources，
/// 装好的应用首次启动就从本地解压，不再访问网络。
///
/// 这样仓库保持干净（不含第三方二进制），而自用版本又是真正的一步到位。
pub fn bundled_archive(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().resource_dir().ok()?;
    // Tauri 打包 resources 时保持相对路径，两种层级都认一下
    for rel in ["engine/NapCat.Shell.zip", "NapCat.Shell.zip"] {
        let path = dir.join(rel);
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

/// 从本地压缩包安装。
pub fn install_from_archive(app: &AppHandle, target: &Path, archive: &Path) -> AppResult<()> {
    if !archive.is_file() {
        return Err(AppError::msg(format!(
            "压缩包不存在：{}",
            archive.display()
        )));
    }
    emit_progress(app, "unpack", 10, "正在解压…");
    fs::create_dir_all(target)?;
    // 先解到临时目录，成功后再并进去，避免解压失败留下半个引擎。
    let staging = target.join(".staging");
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging)?;

    extract(app, archive, &staging)?;
    emit_progress(app, "unpack", 80, "正在整理目录…");
    merge_into(&staging, target)?;
    let _ = fs::remove_dir_all(&staging);

    if engine::entrypoint(target).is_none() {
        return Err(AppError::msg(
            "解压完成，但没找到启动入口。可能这个包里只有插件而没有 NapCat 本体。",
        ));
    }
    emit_progress(app, "done", 100, "引擎已就绪");
    Ok(())
}

/// 压缩包里是不是 V8 兼容引擎包。只读 zip 目录，不解压。
pub fn archive_contains_v8(archive: &Path) -> AppResult<bool> {
    let file = fs::File::open(archive)?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|err| AppError::msg(format!("不是有效的 zip 包：{err}")))?;
    let wanted = ["qq.exe", "winmm.dll", "snowcat-boot.js", "napcat.mjs"];
    let mut seen: Vec<String> = Vec::new();
    for index in 0..zip.len().min(MAX_ZIP_ENTRIES) {
        let Ok(entry) = zip.by_index(index) else {
            continue;
        };
        let Some(relative) = entry.enclosed_name() else {
            continue;
        };
        let Some(name) = relative
            .file_name()
            .map(|name| name.to_string_lossy().to_ascii_lowercase())
        else {
            continue;
        };
        if wanted.contains(&name.as_str()) && !seen.iter().any(|item| item == &name) {
            seen.push(name);
        }
        if seen.len() == wanted.len() {
            return Ok(true);
        }
    }
    Ok(seen.len() == wanted.len())
}

/// 在一个目录（含一到两层子目录）里找兼容引擎包的根。
/// 发布包常见的结构是 `xxx.zip` 里再套一层目录，甚至再套一层版本号。
pub fn find_v8_root(dir: &Path) -> Option<PathBuf> {
    if let Some(found) = engine::v8_bundle_at(dir) {
        return Some(found);
    }
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        if let Some(found) = engine::v8_bundle_at(&path) {
            return Some(found);
        }
        let Ok(children) = fs::read_dir(&path) else {
            continue;
        };
        for child in children.flatten() {
            let child_path = child.path();
            if child_path.is_dir() {
                if let Some(found) = engine::v8_bundle_at(&child_path) {
                    return Some(found);
                }
            }
        }
    }
    None
}

/// 兼容引擎包安装到应用自己的数据目录，返回安装后的根目录。
/// 这样「导入压缩包」不依赖用户把包留在哪里，后续升级/清理也有固定位置。
pub fn v8_install_dir(app: &AppHandle) -> AppResult<PathBuf> {
    let base = app
        .path()
        .app_local_data_dir()
        .map_err(|err| AppError::msg(format!("取应用数据目录失败：{err}")))?;
    Ok(base.join("engine").join("v8"))
}

pub fn install_v8_from_archive(app: &AppHandle, archive: &Path) -> AppResult<PathBuf> {
    if !archive.is_file() {
        return Err(AppError::msg(format!(
            "压缩包不存在：{}",
            archive.display()
        )));
    }
    let dest = v8_install_dir(app)?;
    let parent = dest
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(std::env::temp_dir);
    fs::create_dir_all(&parent)?;
    let staging = parent.join(".v8-staging");
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging)?;

    emit_progress(app, "unpack", 10, "正在解压兼容引擎包…");
    if let Err(err) = extract(app, archive, &staging) {
        let _ = fs::remove_dir_all(&staging);
        return Err(err);
    }
    let Some(root) = find_v8_root(&staging) else {
        let _ = fs::remove_dir_all(&staging);
        return Err(AppError::msg(
            "压缩包里没有找到兼容引擎包。需要 QQ.exe / winmm.dll / snowcat-boot.js / napcat.mjs \
             四个文件在同一目录。",
        ));
    };
    emit_progress(app, "unpack", 85, "正在安装引擎…");
    let _ = fs::remove_dir_all(&dest);
    if root == staging {
        fs::rename(&staging, &dest).map_err(|err| {
            AppError::msg(format!("移动引擎目录失败：{err}；请先退出占用该目录的程序"))
        })?;
    } else {
        fs::rename(&root, &dest).map_err(|err| {
            AppError::msg(format!("移动引擎目录失败：{err}；请先退出占用该目录的程序"))
        })?;
        let _ = fs::remove_dir_all(&staging);
    }
    emit_progress(app, "done", 100, "引擎已就绪");
    Ok(dest)
}

/// 本机常见位置找到的引擎，供登录页「自动查找」使用。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineCandidate {
    /// v8 = 兼容引擎包；napcat = 经典 NapCat 目录
    pub kind: String,
    pub path: String,
}

fn push_candidate(list: &mut Vec<EngineCandidate>, kind: &str, path: &Path) {
    let text = path.to_string_lossy().to_string();
    if list.iter().any(|item| item.path == text) {
        return;
    }
    list.push(EngineCandidate {
        kind: kind.into(),
        path: text,
    });
}

fn scan_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(home) = std::env::var("USERPROFILE") {
        let home = PathBuf::from(home);
        roots.push(home.join("Downloads"));
        roots.push(home.join("Desktop"));
        roots.push(home.join("Documents"));
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        roots.push(PathBuf::from(local).join("Sylk"));
    }
    if let Ok(roaming) = std::env::var("APPDATA") {
        roots.push(PathBuf::from(roaming).join("app.sylk.desktop"));
    }
    for drive in ["C:\\", "D:\\", "E:\\"] {
        roots.push(PathBuf::from(drive));
    }
    roots
}

/// 扫描下载/桌面/文档、应用数据目录和各盘根目录，找现成引擎。
/// 限制检查数量与耗时，避免在机械硬盘或大目录上卡住登录页。
pub fn scan_local_engines() -> Vec<EngineCandidate> {
    let started = Instant::now();
    let mut found: Vec<EngineCandidate> = Vec::new();
    let mut checked = 0usize;

    'outer: for root in scan_roots() {
        let Ok(entries) = fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            if found.len() >= 8 || checked >= 800 || started.elapsed() > Duration::from_secs(3) {
                break 'outer;
            }
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            checked += 1;
            if engine::v8_bundle_at(&path).is_some() {
                push_candidate(&mut found, "v8", &path);
                continue;
            }

            // 解压出来的包通常还套一层：Downloads/<name>/<name>/。
            // 先看子目录，最后才用「父目录里能找到入口」兜底，
            // 否则 qq-v8/ 这种父目录会被误判成 NapCat 而漏掉里面的兼容引擎包。
            let mut matched = false;
            if let Ok(children) = fs::read_dir(&path) {
                for child in children.flatten() {
                    if found.len() >= 8
                        || checked >= 800
                        || started.elapsed() > Duration::from_secs(3)
                    {
                        break 'outer;
                    }
                    let child_path = child.path();
                    if !child_path.is_dir() {
                        continue;
                    }
                    checked += 1;
                    if engine::v8_bundle_at(&child_path).is_some() {
                        push_candidate(&mut found, "v8", &child_path);
                        matched = true;
                    } else if engine::entrypoint(&child_path).is_some() {
                        push_candidate(&mut found, "napcat", &child_path);
                        matched = true;
                    }
                }
            }
            if !matched && engine::entrypoint(&path).is_some() {
                push_candidate(&mut found, "napcat", &path);
            }
        }
    }
    found
}

/// 自动下载并安装。
pub async fn download_and_install(
    app: AppHandle,
    target: PathBuf,
    settings: EngineSettings,
) -> AppResult<()> {
    let urls: Vec<String> = if settings.download_url.trim().is_empty() {
        CANDIDATES.iter().map(|url| url.to_string()).collect()
    } else {
        vec![settings.download_url.trim().to_string()]
    };
    for url in &urls {
        crate::privacy::validate_remote_url(url, "引擎下载地址")?;
    }

    fs::create_dir_all(&target)?;
    let archive = target.join("engine-download.zip");
    let mut last_error = String::new();

    for url in &urls {
        emit_progress(&app, "download", 2, "正在连接下载源…");
        match fetch(&app, url, &archive).await {
            Ok(bytes) => {
                tracing::info!("引擎下载完成：{bytes} 字节，来自 {url}");
                emit_progress(&app, "unpack", 55, "正在解压…");
                let staging = target.join(".staging");
                let _ = fs::remove_dir_all(&staging);
                fs::create_dir_all(&staging)?;
                if let Err(err) = extract(&app, &archive, &staging) {
                    last_error = err.to_string();
                    let _ = fs::remove_dir_all(&staging);
                    continue;
                }
                merge_into(&staging, &target)?;
                let _ = fs::remove_dir_all(&staging);
                let _ = fs::remove_file(&archive);
                if engine::entrypoint(&target).is_none() {
                    last_error = "下载包里没有启动入口，可能下到的是插件包".into();
                    continue;
                }
                emit_progress(&app, "done", 100, "引擎已就绪");
                return Ok(());
            }
            Err(err) => {
                last_error = err.to_string();
                tracing::warn!("下载失败 {url}：{err}");
            }
        }
    }

    Err(AppError::msg(format!(
        "自动获取失败：{last_error}。可以在设置里指定已有的 NapCat 目录，或选择本地压缩包手动安装。"
    )))
}

async fn fetch(app: &AppHandle, url: &str, target: &Path) -> AppResult<u64> {
    // 下载和普通接口不一样：连接要快速失败，主体不能有总时长上限。
    // 用一个独立客户端，10 秒连不上就换下一个源，别让用户对着进度条干等。
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .user_agent(format!("Sylk/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|err| AppError::msg(format!("初始化下载客户端失败：{err}")))?;

    let response = client
        .get(url)
        .header("accept", "application/octet-stream")
        .send()
        .await
        .map_err(|err| {
            if err.is_timeout() {
                AppError::msg(format!("连接超时（10 秒）：{url}"))
            } else {
                AppError::msg(format!("下载请求失败：{err}"))
            }
        })?;

    if !response.status().is_success() {
        return Err(AppError::msg(format!(
            "下载源返回 HTTP {}",
            response.status().as_u16()
        )));
    }

    let total = response.content_length().unwrap_or(0);
    if total > MAX_DOWNLOAD_BYTES {
        return Err(AppError::msg(format!(
            "发布包体积异常（{}），已中止下载",
            crate::media::human_size(total)
        )));
    }
    let mut file = fs::File::create(target)?;
    let mut downloaded: u64 = 0;
    let mut stream = response.bytes_stream();
    let mut last_percent = 0u8;

    let mut last_data = Instant::now();
    while let Some(chunk) = stream.next().await {
        // 卡住 30 秒没有任何字节，就当这个源废了
        if last_data.elapsed() > Duration::from_secs(30) {
            return Err(AppError::msg("下载停滞超过 30 秒，已放弃这个源"));
        }
        let chunk = chunk.map_err(|err| AppError::msg(format!("下载中断：{err}")))?;
        last_data = Instant::now();
        downloaded += chunk.len() as u64;
        if downloaded > MAX_DOWNLOAD_BYTES {
            let _ = fs::remove_file(target);
            return Err(AppError::msg("下载内容超过大小上限，已中止"));
        }
        file.write_all(&chunk)?;
        if total > 0 {
            let percent = ((downloaded as f64 / total as f64) * 50.0 + 4.0).min(54.0) as u8;
            if percent != last_percent {
                last_percent = percent;
                emit_progress(
                    app,
                    "download",
                    percent,
                    &format!("已下载 {}", crate::media::human_size(downloaded)),
                );
            }
        }
    }
    file.flush()?;
    if downloaded < 1024 {
        return Err(AppError::msg("下载内容过小，可能不是有效的发布包"));
    }
    Ok(downloaded)
}

fn extract(app: &AppHandle, archive: &Path, target: &Path) -> AppResult<()> {
    let file = fs::File::open(archive)?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|err| AppError::msg(format!("不是有效的 zip 包：{err}")))?;
    let count = zip.len();
    if count > MAX_ZIP_ENTRIES {
        return Err(AppError::msg(format!(
            "压缩包条目过多（{count}），已拒绝解压"
        )));
    }
    let mut total_bytes: u64 = 0;
    for index in 0..count {
        let mut entry = zip
            .by_index(index)
            .map_err(|err| AppError::msg(format!("读取压缩包失败：{err}")))?;

        // zip 里的路径可能带 ../，必须挡住
        let Some(relative) = entry.enclosed_name() else {
            continue;
        };
        let out_path = target.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&out_path)?;
            continue;
        }
        let declared = entry.size();
        if declared > MAX_ZIP_ENTRY_BYTES {
            return Err(AppError::msg("压缩包内单个文件过大，已拒绝解压"));
        }
        total_bytes = total_bytes.saturating_add(declared);
        if total_bytes > MAX_ZIP_TOTAL_BYTES {
            return Err(AppError::msg("压缩包解压后体积超过上限，已拒绝解压"));
        }
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)?;
        }
        // 先按声明大小预分配，再用受上限约束的读取，避免被伪造头部的包撑爆内存。
        let mut buffer = Vec::with_capacity(declared.min(16 * 1024 * 1024) as usize);
        entry.by_ref().take(declared + 1).read_to_end(&mut buffer)?;
        if buffer.len() as u64 != declared {
            return Err(AppError::msg("压缩包内文件大小与声明不一致，已拒绝"));
        }
        fs::write(&out_path, buffer)?;

        if index % 40 == 0 {
            let percent = 55 + ((index as f64 / count as f64) * 24.0) as u8;
            emit_progress(
                app,
                "unpack",
                percent.min(79),
                &format!("已解压 {}/{} 个文件", index + 1, count),
            );
        }
    }
    Ok(())
}

/// 把 staging 里的内容并入目标目录。若 staging 只有一个顶层目录（发布包的常见结构），
/// 就把那一层剥掉，免得引擎路径里多套一层 `NapCat.Shell`。
fn merge_into(staging: &Path, target: &Path) -> AppResult<()> {
    let entries: Vec<PathBuf> = fs::read_dir(staging)?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .collect();

    let source = if entries.len() == 1 && entries[0].is_dir() {
        entries[0].clone()
    } else {
        staging.to_path_buf()
    };

    for entry in fs::read_dir(&source)? {
        let entry = entry?;
        let from = entry.path();
        let to = target.join(entry.file_name());
        if from.is_dir() {
            fs::create_dir_all(&to)?;
            merge_into(&from, &to)?;
        } else {
            fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flattens_single_top_level_dir() {
        let root = std::env::temp_dir().join("sylk-merge-test");
        let _ = fs::remove_dir_all(&root);
        let staging = root.join("staging");
        let target = root.join("target");
        let inner = staging.join("NapCat.Shell");
        fs::create_dir_all(&inner).unwrap();
        fs::write(inner.join("napcat.bat"), "echo hi").unwrap();
        fs::create_dir_all(&target).unwrap();

        merge_into(&staging, &target).unwrap();
        assert!(target.join("napcat.bat").is_file());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_missing_dir() {
        let mut settings = EngineSettings::default();
        assert!(adopt(&mut settings, r"Z:\definitely\not\here").is_err());
    }
}
