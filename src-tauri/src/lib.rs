#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod asr;
mod commands;
mod config;
mod db;
mod engine;
mod error;
mod export;
mod media;
mod models;
mod napcat;
mod pipeline;
mod privacy;
mod provision;
mod state;

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, RunEvent};

use crate::config::Paths;
use crate::engine::Engine;
use crate::models::ConnectionState;
use crate::state::{AppState, Inner};

fn init_logging(log_dir: &std::path::Path) {
    use tracing_subscriber::prelude::*;
    let file_appender = tracing_appender::rolling::daily(log_dir, "sylk.log");
    let (file_writer, guard) = tracing_appender::non_blocking(file_appender);
    // 守卫要活到进程结束，泄漏一份最省事。
    Box::leak(Box::new(guard));

    let filter = tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        tracing_subscriber::EnvFilter::new("sylk=info,tao=warn,tungstenite=warn")
    });

    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(file_writer)
                .with_ansi(false),
        )
        .with(tracing_subscriber::fmt::layer().with_writer(std::io::stderr))
        .try_init();
}

fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 Sylk", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    let mut builder = TrayIconBuilder::with_id("sylk-tray")
        .tooltip("Sylk · 声匣")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    let tray = builder.build(app)?;
    app.manage(TrayHandle(tray));
    Ok(())
}

struct TrayHandle(#[allow(dead_code)] tauri::tray::TrayIcon);

/// 进程启动时刻。用来量「从双击到能点」到底花了几秒，而不是凭感觉。
static BOOT: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();

pub fn run() {
    let _ = BOOT.set(std::time::Instant::now());
    let builder = tauri::Builder::default()
        // 必须第一个注册：第二个实例启动时立刻退出，把已有窗口叫到前台。
        // 否则双击两次就有两个进程、两个引擎、两个数据库连接在抢同一份文件。
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let boot_ms = || {
                BOOT.get()
                    .map(|start| start.elapsed().as_millis() as u64)
                    .unwrap_or(0)
            };

            create_main_window(app)?;
            // 窗口一建好就开始导航，之后的初始化不再挡着首帧
            tracing::info!("窗口已创建 · +{} ms", boot_ms());

            let handle = app.handle().clone();
            let paths = Paths::resolve(&handle)?;
            init_logging(&paths.log_dir);
            tracing::info!(
                "Sylk 启动，数据目录 {} · +{} ms",
                paths.data_dir.display(),
                boot_ms()
            );

            let mut settings = config::load_settings(&paths.settings_file);
            if settings.library_dir.trim().is_empty() {
                settings.library_dir = config::default_library_dir(&paths.data_dir)
                    .to_string_lossy()
                    .to_string();
            }
            if let Err(err) = config::ensure_dir(std::path::Path::new(&settings.library_dir)) {
                tracing::warn!("媒体库目录不可用：{err}");
            }
            if let Err(err) = config::save_settings(&paths.settings_file, &settings) {
                tracing::warn!("设置写入失败：{err}");
            }

            let connection = ConnectionState::default();

            let http = reqwest::Client::builder()
                .timeout(Duration::from_secs(45))
                .user_agent(format!("Sylk/{}", env!("CARGO_PKG_VERSION")))
                .build()
                .map_err(|err| format!("初始化 HTTP 客户端失败：{err}"))?;

            let conn = db::open(&paths.db_file).map_err(|err| format!("打开数据库失败：{err}"))?;
            let account = db::get_account(&conn).unwrap_or(None);

            let inner = Arc::new(Inner {
                engine: Arc::new(Engine::default()),
                paths,
                db: Mutex::new(conn),
                settings: RwLock::new(settings),
                http,
                conn: RwLock::new(connection),
                account: RwLock::new(account),
                stop: std::sync::atomic::AtomicBool::new(false),
                syncing: std::sync::atomic::AtomicBool::new(false),
            });

            app.manage(AppState(inner.clone()));

            setup_tray(&handle)?;

            // 隐私层的启动动作：日志保留期清理、截屏防护、过期归档清理。
            privacy::prune_logs(&inner);
            privacy::apply_capture_for(
                &handle,
                inner.settings_snapshot().privacy.block_screen_capture,
            );
            {
                let purge_handle = handle.clone();
                let purge_inner = inner.clone();
                std::thread::spawn(move || {
                    // 让引擎/数据库先稳定下来，再跑第一轮过期清理。
                    std::thread::sleep(Duration::from_secs(10));
                    loop {
                        if purge_inner.is_stopping() {
                            break;
                        }
                        match privacy::purge_expired(&purge_handle, &purge_inner) {
                            Ok(0) => {}
                            Ok(count) => {
                                tracing::info!("按保留策略清理了 {count} 条语音")
                            }
                            Err(err) => tracing::warn!("保留策略清理失败：{err}"),
                        }
                        std::thread::sleep(Duration::from_secs(6 * 3600));
                    }
                });
            }

            if let Some(window) = app.get_webview_window("main") {
                let inner_close = inner.clone();
                let window_handle = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        if inner_close.settings_snapshot().close_to_tray {
                            api.prevent_close();
                            let _ = window_handle.hide();
                        }
                    }
                });
            }

            tracing::info!("后端就绪 · +{} ms", boot_ms());
            pipeline::spawn_download_workers(handle.clone(), inner.clone());
            pipeline::spawn_transcribe_worker(handle.clone(), inner.clone());
            pipeline::spawn_live_listener(handle.clone(), inner.clone());

            // 引擎跟着应用一起活：启动即托管，退出即回收。
            let snapshot = inner.settings_snapshot();
            let engine_settings = snapshot.engine.clone();
            if engine_settings.mode != "external"
                && engine_settings.auto_start
                && snapshot.onboarded
            {
                let app_handle = handle.clone();
                let engine_inner = inner.clone();
                std::thread::spawn(move || {
                    // 给窗口一点时间先画出来，避免启动时卡一下
                    std::thread::sleep(Duration::from_millis(400));
                    if let Err(err) = engine::start_fresh(
                        app_handle,
                        engine_inner.engine.clone(),
                        engine_settings,
                    ) {
                        tracing::warn!("自动启动引擎失败：{err}");
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::save_settings,
            commands::get_connection,
            commands::test_connection,
            commands::connect,
            commands::list_conversations,
            commands::query_voices,
            commands::get_voice,
            commands::get_stats,
            commands::get_app_info,
            commands::sync_index,
            commands::sync_history,
            commands::sync_all,
            commands::update_voice,
            commands::update_conversation,
            commands::delete_voice,
            commands::enqueue_missing,
            commands::enqueue_transcribe,
            commands::list_jobs,
            commands::retry_jobs,
            commands::clear_jobs,
            commands::probe_asr,
            commands::pending_decode,
            commands::read_voice_base64,
            commands::read_voice_audio,
            commands::save_decoded,
            commands::export_conversation,
            commands::export_csv,
            commands::export_single,
            commands::wipe_archive,
            commands::privacy_stats,
            commands::privacy_wipe,
            commands::library_stats,
            commands::engine_status,
            commands::engine_start,
            commands::engine_stop,
            commands::engine_restart,
            commands::engine_logout,
            commands::engine_qrcode,
            commands::engine_prepare,
            commands::engine_adopt_dir,
            commands::engine_install_archive,
            commands::engine_scan,
            commands::engine_diagnose,
            commands::engine_open_dir,
            commands::report_ready,
        ]);

    builder
        .build(tauri::generate_context!())
        .expect("Sylk 初始化失败")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                if let Some(app_state) = app_handle.try_state::<AppState>() {
                    app_state.0.stop.store(true, Ordering::Relaxed);
                    // 引擎是我们拉起来的，退出时也要由我们收尾，
                    // 否则会留下一个占着 QQ 登录态的孤儿进程。
                    let settings = app_state.0.settings_snapshot();
                    engine::stop(app_handle, &app_state.0.engine, &settings.engine);
                }
            }
        });
}

/// 建主窗口。
///
/// 之所以不在 tauri.conf.json 里声明，是为了把 `--remote-debugging-port` 这类
/// 只用于自动化的参数挪到环境变量后面：改配置会让 tauri-build 判定失效、
/// 触发整包重链，一条调试参数不值得付那个代价。
fn create_main_window(app: &tauri::App) -> tauri::Result<()> {
    let mut builder = tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
        .title("Sylk · 声匣")
        // 发布版不开 DevTools；调试构建保留，方便排查界面问题。
        .devtools(cfg!(debug_assertions))
        .inner_size(1440.0, 920.0)
        .min_inner_size(1080.0, 680.0)
        .center()
        .resizable(true)
        .visible(true);

    if let Ok(port) = std::env::var("SYLK_CDP_PORT") {
        if !port.trim().is_empty() {
            builder = builder.additional_browser_args(&format!(
                "--remote-debugging-port={} --autoplay-policy=no-user-gesture-required",
                port.trim()
            ));
        }
    }

    builder.build()?;
    Ok(())
}
