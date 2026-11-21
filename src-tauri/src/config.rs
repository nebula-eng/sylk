use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};
use crate::models::Settings;

/// 应用运行时需要的全部固定路径。
#[derive(Debug, Clone)]
pub struct Paths {
    pub data_dir: PathBuf,
    #[allow(dead_code)]
    pub config_dir: PathBuf,
    pub db_file: PathBuf,
    pub settings_file: PathBuf,
    pub log_dir: PathBuf,
}

impl Paths {
    pub fn resolve(app: &AppHandle) -> AppResult<Self> {
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|err| AppError::msg(format!("无法定位应用数据目录：{err}")))?;
        let config_dir = app
            .path()
            .app_config_dir()
            .map_err(|err| AppError::msg(format!("无法定位应用配置目录：{err}")))?;
        let log_dir = app
            .path()
            .app_log_dir()
            .map_err(|err| AppError::msg(format!("无法定位日志目录：{err}")))?;

        for dir in [&data_dir, &config_dir, &log_dir] {
            fs::create_dir_all(dir)?;
        }

        Ok(Self {
            db_file: data_dir.join("sylk.db"),
            settings_file: config_dir.join("settings.json"),
            log_dir,
            data_dir,
            config_dir,
        })
    }
}

/// 默认媒体库：优先放进用户的「文档」目录，让归档结果看得见、找得到。
pub fn default_library_dir(fallback: &Path) -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .map(PathBuf::from);

    if let Some(home) = home {
        let documents = home.join("Documents");
        if documents.is_dir() {
            return documents.join("Sylk Library");
        }
    }
    fallback.join("library")
}

pub fn load_settings(path: &Path) -> Settings {
    let Ok(raw) = fs::read_to_string(path) else {
        return Settings::default();
    };
    match serde_json::from_str::<Settings>(&raw) {
        Ok(mut settings) => {
            // 磁盘上的密钥是 DPAPI 密文；内存里用明文，调用方无需感知。
            settings.asr.api_key = crate::privacy::unprotect_secret(&settings.asr.api_key);
            settings
        }
        Err(err) => {
            // 配置损坏时不要静默丢弃，留一份备份方便排查。
            let backup = path.with_extension("json.broken");
            let _ = fs::copy(path, backup);
            tracing::warn!("settings.json 解析失败，已备份并回退默认值：{err}");
            Settings::default()
        }
    }
}

pub fn save_settings(path: &Path, settings: &Settings) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    // 密钥只以 DPAPI 密文落盘；其余设置保持人类可读便于排查。
    let mut stored = settings.clone();
    stored.asr.api_key = crate::privacy::protect_secret(&settings.asr.api_key);
    let text = serde_json::to_string_pretty(&stored)?;
    // 先写临时文件再改名，避免写一半断电留下坏配置。
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

pub fn ensure_dir(path: &Path) -> AppResult<()> {
    fs::create_dir_all(path)?;
    Ok(())
}
