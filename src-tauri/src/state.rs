use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, RwLock};

use rusqlite::Connection;
use tauri::{AppHandle, Emitter};

use crate::config::Paths;
use crate::engine::Engine;
use crate::models::{Account, ConnectionState, Settings};

pub const EV_CONNECTION: &str = "sylk://connection";
pub const EV_ENGINE: &str = "sylk://engine";
pub const EV_PROGRESS: &str = "sylk://progress";
pub const EV_VOICES: &str = "sylk://voices";
pub const EV_JOBS: &str = "sylk://jobs";
pub const EV_TOAST: &str = "sylk://toast";

/// 跨线程共享的运行时上下文。
pub struct Inner {
    pub paths: Paths,
    pub db: Mutex<Connection>,
    pub settings: RwLock<Settings>,
    pub http: reqwest::Client,
    pub conn: RwLock<ConnectionState>,
    pub account: RwLock<Option<Account>>,
    pub stop: AtomicBool,
    pub syncing: AtomicBool,
    /// 内嵌引擎。所有需要 OneBot 的地方都从它取端点。
    pub engine: Arc<Engine>,
}

pub struct AppState(pub Arc<Inner>);

impl Inner {
    /// 锁中毒时继续用旧数据，比整个应用崩掉要好。
    pub fn db(&self) -> MutexGuard<'_, Connection> {
        self.db.lock().unwrap_or_else(|err| err.into_inner())
    }

    pub fn settings_snapshot(&self) -> Settings {
        self.settings
            .read()
            .unwrap_or_else(|err| err.into_inner())
            .clone()
    }

    pub fn apply_settings(&self, next: Settings) -> crate::error::AppResult<()> {
        crate::config::save_settings(&self.paths.settings_file, &next)?;
        *self.settings.write().unwrap_or_else(|err| err.into_inner()) = next;
        Ok(())
    }

    pub fn connection(&self) -> ConnectionState {
        self.conn
            .read()
            .unwrap_or_else(|err| err.into_inner())
            .clone()
    }

    pub fn set_connection(&self, app: &AppHandle, next: ConnectionState) {
        *self.conn.write().unwrap_or_else(|err| err.into_inner()) = next.clone();
        let _ = app.emit(EV_CONNECTION, next);
    }

    pub fn account_uin(&self) -> String {
        self.account
            .read()
            .unwrap_or_else(|err| err.into_inner())
            .as_ref()
            .map(|account| account.uin.clone())
            .unwrap_or_default()
    }

    pub fn set_account(&self, account: Option<Account>) {
        *self.account.write().unwrap_or_else(|err| err.into_inner()) = account;
    }

    pub fn is_stopping(&self) -> bool {
        self.stop.load(Ordering::Relaxed)
    }

    /// 当前应当使用的 OneBot 端点。
    /// embedded 模式由引擎动态给出（端口是每次启动现算的）；
    /// external 模式回落到用户手填的地址。
    pub fn napcat_endpoints(&self) -> (String, String, String) {
        let settings = self.settings_snapshot();
        if settings.engine.mode != "external" {
            if let Some((http, ws, token)) = self.engine.endpoints() {
                return (http, ws, token);
            }
        }
        (
            settings.napcat.base_url.clone(),
            settings.napcat.ws_url.clone(),
            settings.napcat.token.clone(),
        )
    }

    /// 引擎是否已经可以服务请求。
    pub fn endpoints_ready(&self) -> bool {
        let settings = self.settings_snapshot();
        if settings.engine.mode == "external" {
            return true;
        }
        let phase = self.engine.rt().phase.clone();
        matches!(
            phase.as_str(),
            "awaiting_scan" | "scanned" | "online" | "starting"
        )
    }
}

pub fn toast(app: &AppHandle, kind: &str, text: impl Into<String>) {
    let _ = app.emit(
        EV_TOAST,
        serde_json::json!({ "kind": kind, "text": text.into() }),
    );
}

pub fn progress(
    app: &AppHandle,
    scope: &str,
    current: i64,
    total: i64,
    label: impl Into<String>,
    done: bool,
) {
    let _ = app.emit(
        EV_PROGRESS,
        crate::models::ProgressEvent {
            scope: scope.into(),
            current,
            total,
            label: label.into(),
            done,
        },
    );
}
