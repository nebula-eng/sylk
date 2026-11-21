use std::path::PathBuf;
use std::sync::Arc;

use base64::Engine as _;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::config;
use crate::db;
use crate::engine;
use crate::error::{AppError, AppResult};
use crate::export;
use crate::media;
use crate::models::*;
use crate::pipeline;
use crate::provision;
use crate::state::{self, AppState, EV_ENGINE, EV_VOICES};

fn inner(app: &AppHandle) -> Arc<state::Inner> {
    app.state::<AppState>().0.clone()
}

fn library_dir(app: &AppHandle) -> PathBuf {
    PathBuf::from(inner(app).settings_snapshot().library_dir)
}

// ---------------------------------------------------------------------------
// 设置与连接
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> Settings {
    state.0.settings_snapshot()
}

#[tauri::command]
pub fn save_settings(app: AppHandle, settings: Settings) -> AppResult<Settings> {
    let inner = inner(&app);
    let mut next = settings;
    if next.library_dir.trim().is_empty() {
        next.library_dir = config::default_library_dir(&inner.paths.data_dir)
            .to_string_lossy()
            .to_string();
    }
    // 用户填写的出站地址在保存时就校验，避免到真正下载/转写时才把错误暴露出来。
    if !next.asr.api_base.trim().is_empty() {
        crate::privacy::validate_remote_url(&next.asr.api_base, "云端转写接口地址")?;
    }
    if !next.engine.download_url.trim().is_empty() {
        crate::privacy::validate_remote_url(&next.engine.download_url, "引擎下载地址")?;
    }
    config::ensure_dir(&PathBuf::from(&next.library_dir))?;
    inner.apply_settings(next.clone())?;
    // 截屏防护是窗口级设置，保存后立刻生效；不支持的系统只记日志，不打断保存。
    crate::privacy::apply_capture_for(&app, next.privacy.block_screen_capture);
    Ok(next)
}

#[tauri::command]
pub fn get_connection(state: State<'_, AppState>) -> ConnectionState {
    state.0.connection()
}

#[tauri::command]
pub async fn test_connection(app: AppHandle) -> AppResult<ConnectionState> {
    let inner = inner(&app);
    pipeline::test_connection(&inner).await
}

#[tauri::command]
pub async fn connect(app: AppHandle) -> AppResult<ConnectionState> {
    let inner = inner(&app);
    let mut result = pipeline::test_connection(&inner).await?;
    if result.status == "online" {
        match pipeline::refresh_account(&inner).await {
            Ok(account) => {
                result.account = Some(account);
            }
            Err(err) => {
                result.status = "error".into();
                result.message = err.to_string();
            }
        }
    }
    if result.status == "online" {
        if let Err(err) = pipeline::sync_index(&app, &inner).await {
            tracing::warn!("会话索引同步失败：{err}");
        }
        // 上次没下完的、解码失败的，连上之后自动补一遍，不用用户去翻任务队列。
        let _ = pipeline::requeue_missing(&inner);
        let _ = tauri::Emitter::emit(&app, crate::state::EV_JOBS, serde_json::json!({}));
    }
    result.live = inner.connection().live;
    inner.set_connection(&app, result.clone());
    Ok(result)
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_conversations(
    state: State<'_, AppState>,
    keyword: Option<String>,
) -> AppResult<Vec<Conversation>> {
    let conn = state.0.db();
    db::list_conversations(&conn, keyword.unwrap_or_default().trim())
}

#[tauri::command]
pub fn query_voices(state: State<'_, AppState>, query: VoiceQuery) -> AppResult<VoicePage> {
    let conn = state.0.db();
    db::query_voices(&conn, &query)
}

#[tauri::command]
pub fn get_voice(state: State<'_, AppState>, id: i64) -> AppResult<Option<Voice>> {
    let conn = state.0.db();
    db::voice(&conn, id)
}

#[tauri::command]
pub fn get_stats(state: State<'_, AppState>) -> AppResult<StatsBundle> {
    let conn = state.0.db();
    db::stats(&conn)
}

#[tauri::command]
pub fn get_app_info(state: State<'_, AppState>) -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").into(),
        library_dir: state.0.settings_snapshot().library_dir,
        db_path: state.0.paths.db_file.to_string_lossy().to_string(),
        data_dir: state.0.paths.data_dir.to_string_lossy().to_string(),
        platform: std::env::consts::OS.into(),
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub library_dir: String,
    pub db_path: String,
    pub data_dir: String,
    pub platform: String,
}

// ---------------------------------------------------------------------------
// 同步
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn sync_index(app: AppHandle) -> AppResult<i64> {
    let inner = inner(&app);
    pipeline::sync_index(&app, &inner).await
}

#[tauri::command]
pub async fn sync_history(
    app: AppHandle,
    conversation_id: i64,
    pages: Option<u32>,
) -> AppResult<SyncReport> {
    let inner = inner(&app);
    if inner
        .syncing
        .swap(true, std::sync::atomic::Ordering::SeqCst)
    {
        return Err(AppError::msg("已有回溯任务在进行中，请稍后再试"));
    }
    let result = pipeline::sync_history(&app, &inner, conversation_id, pages.unwrap_or(10)).await;
    inner
        .syncing
        .store(false, std::sync::atomic::Ordering::SeqCst);
    result
}

/// 后台批量回溯，立即返回；进度通过事件推送。
#[tauri::command]
pub async fn sync_all(app: AppHandle, pages_per_conversation: Option<u32>) -> AppResult<()> {
    let inner = inner(&app);
    if inner
        .syncing
        .swap(true, std::sync::atomic::Ordering::SeqCst)
    {
        return Err(AppError::msg("已有回溯任务在进行中"));
    }
    let pages = pages_per_conversation.unwrap_or(2).clamp(1, 40);
    let list = {
        let conn = inner.db();
        db::list_conversations(&conn, "")?
    };
    let total = list.len() as i64;
    let app_bg = app.clone();
    let inner_bg = inner.clone();
    tauri::async_runtime::spawn(async move {
        for (index, conversation) in list.iter().enumerate() {
            if inner_bg.is_stopping() {
                break;
            }
            state::progress(
                &app_bg,
                "sync-all",
                index as i64 + 1,
                total,
                format!("正在回溯 {}", conversation.title),
                false,
            );
            if let Err(err) =
                pipeline::sync_history(&app_bg, &inner_bg, conversation.id, pages).await
            {
                tracing::warn!("回溯 {} 失败：{err}", conversation.title);
            }
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        }
        inner_bg
            .syncing
            .store(false, std::sync::atomic::Ordering::SeqCst);
        state::progress(&app_bg, "sync-all", total, total, "批量回溯完成", true);
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// 编辑
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn update_voice(
    app: AppHandle,
    id: i64,
    starred: bool,
    note: String,
    tags: Vec<String>,
) -> AppResult<Voice> {
    let inner = inner(&app);
    {
        let conn = inner.db();
        db::set_voice_flags(&conn, id, starred, &note, &tags)?;
    }
    let _ = tauri::Emitter::emit(
        &app,
        EV_VOICES,
        serde_json::json!({ "reason": "updated", "voiceId": id }),
    );
    let conn = inner.db();
    db::voice(&conn, id)?.ok_or_else(|| AppError::msg("语音不存在"))
}

#[tauri::command]
pub fn update_conversation(
    app: AppHandle,
    id: i64,
    starred: bool,
    remark: String,
) -> AppResult<Conversation> {
    let inner = inner(&app);
    {
        let conn = inner.db();
        db::set_conversation_star(&conn, id, starred)?;
        db::set_conversation_remark(&conn, id, &remark)?;
    }
    let conn = inner.db();
    db::conversation(&conn, id)?.ok_or_else(|| AppError::msg("会话不存在"))
}

#[tauri::command]
pub fn delete_voice(app: AppHandle, id: i64) -> AppResult<()> {
    let inner = inner(&app);
    let paths = {
        let conn = inner.db();
        db::voice_source(&conn, id)?
    };
    {
        let conn = inner.db();
        db::delete_voice(&conn, id)?;
    }
    if let Some(source) = paths {
        for path in [source.file_path, source.raw_path] {
            if !path.is_empty() && std::path::Path::new(&path).is_file() {
                let _ = std::fs::remove_file(path);
            }
        }
    }
    let _ = tauri::Emitter::emit(
        &app,
        EV_VOICES,
        serde_json::json!({ "reason": "deleted", "voiceId": id }),
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// 任务
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn enqueue_missing(state: State<'_, AppState>) -> AppResult<i64> {
    let conn = state.0.db();
    let ids = db::voices_missing_media(&conn, 500)?;
    for id in &ids {
        db::enqueue_job(&conn, "download", *id)?;
    }
    Ok(ids.len() as i64)
}

#[tauri::command]
pub fn enqueue_transcribe(state: State<'_, AppState>, limit: Option<u32>) -> AppResult<i64> {
    if !state.0.settings_snapshot().asr.enabled {
        return Err(AppError::msg("请先在设置中启用并配置转写引擎"));
    }
    let conn = state.0.db();
    let ids = db::voices_for_transcribe(&conn, limit.unwrap_or(200))?;
    for id in &ids {
        db::enqueue_job(&conn, "transcribe", *id)?;
    }
    Ok(ids.len() as i64)
}

#[tauri::command]
pub fn list_jobs(state: State<'_, AppState>) -> AppResult<Vec<Job>> {
    let conn = state.0.db();
    db::list_jobs(&conn, 200)
}

#[tauri::command]
pub fn retry_jobs(state: State<'_, AppState>) -> AppResult<()> {
    let conn = state.0.db();
    db::retry_failed_jobs(&conn)
}

#[tauri::command]
pub fn clear_jobs(state: State<'_, AppState>) -> AppResult<()> {
    let conn = state.0.db();
    db::clear_finished_jobs(&conn)
}

#[tauri::command]
pub fn probe_asr(state: State<'_, AppState>) -> AsrProbe {
    crate::asr::probe(&state.0.settings_snapshot().asr)
}

// ---------------------------------------------------------------------------
// SILK 解码协作
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawAudio {
    pub name: String,
    pub kind: String,
    pub data: String,
}

#[tauri::command]
pub fn pending_decode(state: State<'_, AppState>) -> AppResult<Vec<i64>> {
    pipeline::pending_decode_ids(&state.0)
}

/// 前端解码 SILK 需要原始字节，这里用 base64 传过去（语音通常只有几十 KB）。
#[tauri::command]
pub fn read_voice_base64(app: AppHandle, id: i64) -> AppResult<RawAudio> {
    let inner = inner(&app);
    let library = PathBuf::from(inner.settings_snapshot().library_dir);
    let conn = inner.db();
    let source = db::voice_source(&conn, id)?.ok_or_else(|| AppError::msg("语音不存在"))?;
    drop(conn);
    let path = if !source.raw_path.is_empty() {
        source.raw_path
    } else {
        source.file_path
    };
    if path.is_empty() {
        return Err(AppError::msg("这条语音还没有本地文件"));
    }
    // 数据库里的路径也可能被外部改动；只允许读媒体库内部的文件。
    let path = crate::privacy::ensure_under(&library, std::path::Path::new(&path))?;
    let bytes = std::fs::read(&path)?;
    let kind = if media::is_silk(&bytes) {
        "silk"
    } else if media::is_wav(&bytes) {
        "wav"
    } else {
        "unknown"
    };
    Ok(RawAudio {
        name: path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| format!("voice-{id}")),
        kind: kind.into(),
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}

/// 播放器取音频：只返回 WAV 文件，且限定在媒体库目录内。
#[tauri::command]
pub fn read_voice_audio(app: AppHandle, id: i64) -> AppResult<RawAudio> {
    let inner = inner(&app);
    let library = PathBuf::from(inner.settings_snapshot().library_dir);
    let conn = inner.db();
    let source = db::voice_source(&conn, id)?.ok_or_else(|| AppError::msg("语音不存在"))?;
    drop(conn);
    if source.file_path.is_empty() {
        return Err(AppError::msg("这条语音还没有可播放的 WAV"));
    }
    let path = crate::privacy::ensure_under(&library, std::path::Path::new(&source.file_path))?;
    let bytes = std::fs::read(&path)?;
    if !media::is_wav(&bytes) {
        return Err(AppError::msg("本地文件不是 WAV，无法直接播放"));
    }
    Ok(RawAudio {
        name: path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| format!("voice-{id}")),
        kind: "wav".into(),
        data: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}

#[tauri::command]
pub fn save_decoded(
    app: AppHandle,
    id: i64,
    data: String,
    sample_rate: Option<u32>,
) -> AppResult<()> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|err| AppError::msg(format!("解码数据无效：{err}")))?;
    if !media::is_wav(&bytes) {
        return Err(AppError::msg("解码结果不是 WAV"));
    }
    let inner = inner(&app);
    pipeline::save_decoded_wav(&inner, id, &bytes, sample_rate.unwrap_or(24_000))?;
    let _ = tauri::Emitter::emit(
        &app,
        EV_VOICES,
        serde_json::json!({ "reason": "decoded", "voiceId": id }),
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn export_conversation(
    app: AppHandle,
    conversation_id: i64,
    target_dir: Option<String>,
) -> AppResult<ExportReport> {
    let inner = inner(&app);
    let conversation = {
        let conn = inner.db();
        db::conversation(&conn, conversation_id)?
    }
    .ok_or_else(|| AppError::msg("会话不存在"))?;
    let voices = {
        let conn = inner.db();
        db::voices_of_conversation(&conn, conversation_id)?
    };
    if voices.is_empty() {
        return Err(AppError::msg("这个会话还没有归档的语音"));
    }
    let base = match target_dir {
        Some(dir) if !dir.trim().is_empty() => PathBuf::from(dir),
        _ => library_dir(&app).join("exports"),
    };
    export::export_conversation(&base, &conversation, &voices)
}

#[tauri::command]
pub fn export_csv(app: AppHandle, path: String, query: VoiceQuery) -> AppResult<ExportReport> {
    let inner = inner(&app);
    let page = {
        let conn = inner.db();
        let mut query = query;
        query.limit = 5000;
        db::query_voices(&conn, &query)?
    };
    export::export_csv(&PathBuf::from(path), &page.items)
}

#[tauri::command]
pub fn export_single(app: AppHandle, id: i64, target_path: String) -> AppResult<ExportReport> {
    let inner = inner(&app);
    let voice = {
        let conn = inner.db();
        db::voice(&conn, id)?
    }
    .ok_or_else(|| AppError::msg("语音不存在"))?;
    export::export_single(&voice, &PathBuf::from(target_path))
}

// ---------------------------------------------------------------------------
// 维护
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn wipe_archive(app: AppHandle) -> AppResult<()> {
    let inner = inner(&app);
    {
        let conn = inner.db();
        db::wipe_archive(&conn)?;
    }
    let _ = tauri::Emitter::emit(&app, EV_VOICES, serde_json::json!({ "reason": "wiped" }));
    Ok(())
}

#[tauri::command]
pub fn privacy_stats(app: AppHandle) -> crate::privacy::PrivacyStats {
    crate::privacy::stats(&inner(&app))
}

/// 清除本机数据：数据库、媒体文件、引擎登录态与日志。
/// 程序本身与设置（引擎路径、媒体库位置、转写配置）保留。
#[tauri::command]
pub fn privacy_wipe(app: AppHandle) -> AppResult<crate::privacy::WipeReport> {
    let inner = inner(&app);
    let report = crate::privacy::wipe_all(&app, &inner)?;
    let _ = tauri::Emitter::emit(&app, crate::state::EV_CONNECTION, inner.connection());
    Ok(report)
}

#[tauri::command]
pub fn library_stats(app: AppHandle) -> AppResult<serde_json::Value> {
    let root = library_dir(&app);
    let mut files = 0i64;
    let mut bytes = 0i64;
    fn walk(dir: &std::path::Path, files: &mut i64, bytes: &mut i64) {
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
    walk(&root, &mut files, &mut bytes);
    Ok(serde_json::json!({
        "root": root.to_string_lossy(),
        "files": files,
        "bytes": bytes,
    }))
}

// ---------------------------------------------------------------------------
// 内嵌引擎
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn engine_status(app: AppHandle) -> EngineStatus {
    let inner = inner(&app);
    let settings = inner.settings_snapshot();
    inner.engine.status(&settings.engine)
}

#[tauri::command]
pub fn engine_start(app: AppHandle) -> AppResult<EngineStatus> {
    let inner = inner(&app);
    let settings = inner.settings_snapshot();
    let status = engine::start_fresh(app.clone(), inner.engine.clone(), settings.engine.clone())?;
    let _ = app.emit(EV_ENGINE, status.clone());
    Ok(status)
}

#[tauri::command]
pub fn engine_stop(app: AppHandle) -> AppResult<EngineStatus> {
    let inner = inner(&app);
    let settings = inner.settings_snapshot();
    engine::stop(&app, &inner.engine, &settings.engine);
    Ok(inner.engine.status(&settings.engine))
}

#[tauri::command]
pub fn engine_restart(app: AppHandle) -> AppResult<EngineStatus> {
    let inner = inner(&app);
    let settings = inner.settings_snapshot();
    engine::stop(&app, &inner.engine, &settings.engine);
    std::thread::sleep(std::time::Duration::from_millis(700));
    engine::start_fresh(app.clone(), inner.engine.clone(), settings.engine.clone())
}

#[tauri::command]
pub fn engine_logout(app: AppHandle) -> AppResult<EngineStatus> {
    let inner = inner(&app);
    let settings = inner.settings_snapshot();
    engine::logout(&app, inner.engine.clone(), &settings.engine)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QrPayload {
    pub version: u64,
    pub available: bool,
    /// data:image/png;base64,...
    pub data_url: String,
}

#[tauri::command]
pub fn engine_qrcode(app: AppHandle) -> QrPayload {
    let inner = inner(&app);
    match engine::qrcode(&inner.engine) {
        Some((version, bytes)) => QrPayload {
            version,
            available: true,
            data_url: format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            ),
        },
        None => QrPayload {
            version: 0,
            available: false,
            data_url: String::new(),
        },
    }
}

/// 一键准备：已有就采用，没有就下载。
#[tauri::command]
pub async fn engine_prepare(app: AppHandle) -> AppResult<EngineStatus> {
    let inner = inner(&app);
    let mut settings = inner.settings_snapshot();

    // V8 兼容模式：引擎包与 QQ 便携目录都在用户自备目录里，不需要下载。
    if engine::v8_dir(&settings.engine).is_some() {
        return engine::start_fresh(app.clone(), inner.engine.clone(), settings.engine.clone());
    }

    if provision::is_ready(&settings.engine) {
        return Ok(inner.engine.status(&settings.engine));
    }

    let target = engine::default_dir(&inner.paths.data_dir);
    {
        let mut rt = inner.engine.rt();
        rt.phase = "preparing".into();
        rt.detail = "正在获取引擎…".into();
        rt.napcat_dir = target.to_string_lossy().to_string();
    }
    engine::emit(&app, &inner.engine, &settings.engine);

    // 内置包优先：构建时塞进安装包的那份就在本地，解压即可，不碰网络。
    // 上游目录随时可能消失，能不走网络就不走网络。
    let install_result = match provision::bundled_archive(&app) {
        Some(archive) => {
            tracing::info!("使用内置引擎包：{}", archive.display());
            provision::install_from_archive(&app, &target, &archive)
        }
        None => {
            provision::download_and_install(app.clone(), target.clone(), settings.engine.clone())
                .await
        }
    };

    // 装不上不能让界面停在「正在获取引擎」——用户会对着进度条干等到关窗口。
    // 回到 unavailable 状态：那个状态下登录页会直接把三种手动接入方式摆出来。
    if let Err(err) = install_result {
        let mut rt = inner.engine.rt();
        rt.phase = "unavailable".into();
        rt.detail = format!("自动获取失败：{err}");
        rt.last_error = format!("自动获取失败：{err}");
        rt.napcat_dir.clear();
        drop(rt);
        engine::emit(&app, &inner.engine, &settings.engine);
        let message = err.to_string();
        return Err(AppError::msg(message));
    }

    settings.engine.napcat_dir = target.to_string_lossy().to_string();
    inner.apply_settings(settings.clone())?;

    engine::start_fresh(app.clone(), inner.engine.clone(), settings.engine.clone())
}

#[tauri::command]
pub fn engine_adopt_dir(app: AppHandle, dir: String) -> AppResult<EngineStatus> {
    let inner = inner(&app);
    let mut settings = inner.settings_snapshot();
    provision::adopt(&mut settings.engine, &dir)?;
    settings.engine.mode = "embedded".into();
    inner.apply_settings(settings.clone())?;
    engine::start_fresh(app.clone(), inner.engine.clone(), settings.engine.clone())
}

#[tauri::command]
pub async fn engine_install_archive(app: AppHandle, archive: String) -> AppResult<EngineStatus> {
    let inner = inner(&app);
    let mut settings = inner.settings_snapshot();
    let archive_path = PathBuf::from(&archive);
    // 先看压缩包类型：兼容引擎包走独立安装目录，NapCat 包还是解到 engine/napcat。
    if provision::archive_contains_v8(&archive_path).unwrap_or(false) {
        let target = provision::install_v8_from_archive(&app, &archive_path)?;
        settings.engine.qq_path = target.to_string_lossy().to_string();
        settings.engine.napcat_dir.clear();
        settings.engine.mode = "embedded".into();
        inner.apply_settings(settings.clone())?;
        return engine::start_fresh(app.clone(), inner.engine.clone(), settings.engine.clone());
    }
    let target = engine::default_dir(&inner.paths.data_dir);
    provision::install_from_archive(&app, &target, &archive_path)?;
    settings.engine.napcat_dir = target.to_string_lossy().to_string();
    settings.engine.mode = "embedded".into();
    inner.apply_settings(settings.clone())?;
    engine::start_fresh(app.clone(), inner.engine.clone(), settings.engine.clone())
}

/// 在下载/桌面/文档、应用数据目录和各盘根目录里找现成引擎。
#[tauri::command]
pub fn engine_scan() -> Vec<provision::EngineCandidate> {
    provision::scan_local_engines()
}

/// 环境自检：把「为什么起不来」拆成几条人话。
#[tauri::command]
pub fn engine_diagnose(app: AppHandle) -> Vec<serde_json::Value> {
    let inner = inner(&app);
    let settings = inner.settings_snapshot();

    let mut items = Vec::new();
    let v8 = engine::v8_dir(&settings.engine);
    let dir = if v8.is_some() {
        v8.clone()
    } else {
        engine::resolve_dir(&settings.engine)
    };
    items.push(serde_json::json!({
        "key": "engine",
        "label": if v8.is_some() { "V8 兼容引擎" } else { "引擎文件" },
        "ok": if v8.is_some() {
            true
        } else {
            dir.as_ref().and_then(|d| engine::entrypoint(d)).is_some()
        },
        "detail": dir.as_ref().map(|d| d.to_string_lossy().to_string()).unwrap_or_else(|| "未安装".into()),
    }));

    let qq = engine::detect_qq(&settings.engine);
    items.push(serde_json::json!({
        "key": "qq",
        "label": "QQ NT 客户端",
        "ok": qq.is_some(),
        "detail": qq.as_ref().map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|| "未找到，引擎无法注入".into()),
    }));

    let status = inner.engine.status(&settings.engine);
    if !status.qq_version.is_empty() {
        items.push(serde_json::json!({
            "key": "qq_version",
            "label": "QQ 版本",
            "ok": status.launch_mode == "v8",
            "detail": if status.launch_mode == "v8" {
                format!("{}（V8 兼容通道）", status.qq_version)
            } else {
                format!("{}（经典注入；新版本可能不兼容）", status.qq_version)
            },
        }));
    } else {
        items.push(serde_json::json!({
            "key": "qq_version",
            "label": "QQ 版本",
            "ok": false,
            "detail": "读取失败".to_string(),
        }));
    }
    items.push(serde_json::json!({
        "key": "process",
        "label": "引擎进程",
        "ok": status.pid.is_some(),
        "detail": match status.pid { Some(pid) => format!("运行中 · PID {pid}"), None => "未运行".into() },
    }));

    items.push(serde_json::json!({
        "key": "login",
        "label": "账号登录",
        "ok": status.account.is_some(),
        "detail": status.account.as_ref().map(|a| format!("{}（{}）", a.nickname, a.uin)).unwrap_or_else(|| "未登录".into()),
    }));

    items
}

#[tauri::command]
pub fn engine_open_dir(app: AppHandle) -> AppResult<()> {
    let inner = inner(&app);
    let settings = inner.settings_snapshot();
    let dir = engine::resolve_dir(&settings.engine)
        .unwrap_or_else(|| engine::default_dir(&inner.paths.data_dir));
    std::fs::create_dir_all(&dir)?;
    tauri_plugin_opener::open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|err| AppError::msg(format!("打开目录失败：{err}")))
}

/// 前端首帧渲染完成后回调一次，用来量真实的启动耗时。
/// 这个数字写日志，也回给前端显示在「关于」里。
#[tauri::command]
pub fn report_ready(app: AppHandle) -> u64 {
    let ms = crate::BOOT
        .get()
        .map(|start| start.elapsed().as_millis() as u64)
        .unwrap_or(0);
    tracing::info!("首屏就绪 · 从进程启动算起 {ms} ms");
    let _ = app.emit("sylk://ready", ms);
    ms
}
