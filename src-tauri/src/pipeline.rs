use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use tauri::AppHandle;
use tokio::sync::mpsc;

use crate::db::{self, ConversationSeed, NewVoice};
use crate::error::{AppError, AppResult};
use crate::media;
use crate::models::{ConnectionState, SyncReport};
use crate::napcat::{self, IncomingVoice, LiveEvent, NapcatClient};
use crate::state::{self, Inner, EV_JOBS, EV_VOICES};

/// 复用一个进程级客户端：握手、连接池都能省下来。
pub fn http_client() -> reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .timeout(Duration::from_secs(45))
                .user_agent(format!("Sylk/{}", env!("CARGO_PKG_VERSION")))
                .build()
                .unwrap_or_default()
        })
        .clone()
}

fn client(state: &Inner) -> NapcatClient {
    let (base, _, token) = state.napcat_endpoints();
    NapcatClient::new(&base, &token, http_client())
}

fn with_db<T>(
    state: &Inner,
    f: impl FnOnce(&rusqlite::Connection) -> AppResult<T>,
) -> AppResult<T> {
    let conn = state.db();
    f(&conn)
}

fn account_or_placeholder(state: &Inner) -> String {
    let uin = state.account_uin();
    if uin.is_empty() {
        "0".to_string()
    } else {
        uin
    }
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

/// 确保会话存在；陌生群/好友会顺手向 NapCat 问一次名字。
pub async fn ensure_conversation(
    state: &Arc<Inner>,
    kind: &str,
    peer_id: &str,
    fallback: &str,
) -> AppResult<i64> {
    let account = account_or_placeholder(state);
    if let Some(id) = with_db(state, |conn| {
        db::find_conversation(conn, &account, kind, peer_id)
    })? {
        return Ok(id);
    }

    let api = client(state);
    let (title, avatar, members) = if kind == "group" {
        let info = api.group_info(peer_id).await.unwrap_or_default();
        let name = info
            .get("group_name")
            .and_then(|value| value.as_str())
            .filter(|text| !text.is_empty())
            .unwrap_or(fallback);
        (
            name.to_string(),
            napcat::group_avatar(peer_id),
            info.get("member_count")
                .and_then(|value| value.as_i64())
                .unwrap_or(0),
        )
    } else {
        let info = api.stranger_info(peer_id).await.unwrap_or_default();
        let name = info
            .get("nickname")
            .and_then(|value| value.as_str())
            .filter(|text| !text.is_empty())
            .unwrap_or(fallback);
        (name.to_string(), napcat::friend_avatar(peer_id), 0)
    };

    let seed = ConversationSeed {
        account_uin: account,
        kind: kind.to_string(),
        peer_id: peer_id.to_string(),
        title: if title.is_empty() {
            peer_id.to_string()
        } else {
            title
        },
        avatar,
        member_count: members,
    };
    with_db(state, |conn| db::insert_conversation(conn, &seed))
}

/// 从 NapCat 拉群列表与好友列表，写入会话表。
pub async fn sync_index(app: &AppHandle, state: &Arc<Inner>) -> AppResult<i64> {
    let api = client(state);
    let account = account_or_placeholder(state);
    let groups = api.group_list().await?;
    let friends = api.friend_list().await?;

    let mut seeds: Vec<ConversationSeed> = Vec::with_capacity(groups.len() + friends.len());
    for group in &groups {
        let gid = napcat::value_to_string(group.get("group_id"));
        if gid.is_empty() {
            continue;
        }
        seeds.push(ConversationSeed {
            account_uin: account.clone(),
            kind: "group".into(),
            peer_id: gid.clone(),
            title: group
                .get("group_name")
                .and_then(|value| value.as_str())
                .unwrap_or("")
                .to_string(),
            avatar: napcat::group_avatar(&gid),
            member_count: group
                .get("member_count")
                .and_then(|value| value.as_i64())
                .unwrap_or(0),
        });
    }
    for friend in &friends {
        let uid = napcat::value_to_string(friend.get("user_id"));
        if uid.is_empty() {
            continue;
        }
        let nickname = friend
            .get("nickname")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let remark = friend
            .get("remark")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        let title = if remark.is_empty() { nickname } else { remark };
        seeds.push(ConversationSeed {
            account_uin: account.clone(),
            kind: "friend".into(),
            peer_id: uid.clone(),
            title: title.to_string(),
            avatar: napcat::friend_avatar(&uid),
            member_count: 0,
        });
    }

    let count = {
        let mut guard = state.db();
        db::upsert_conversations(&mut guard, &seeds)?
    };

    state::progress(app, "sync", count, count, "会话索引已更新", true);
    let _ = tauri::Emitter::emit(app, EV_VOICES, serde_json::json!({ "reason": "index" }));
    Ok(count)
}

// ---------------------------------------------------------------------------
// 入库
// ---------------------------------------------------------------------------

/// 一条语音进入归档：建会话 → 去重入库 → 排队下载。
pub async fn ingest_voice(
    app: &AppHandle,
    state: &Arc<Inner>,
    incoming: IncomingVoice,
    source: &str,
) -> AppResult<Option<i64>> {
    if state.account_uin().is_empty() {
        return Err(AppError::msg("尚未获取到登录账号，暂时不写入归档"));
    }

    let conversation_id = ensure_conversation(
        state,
        &incoming.kind,
        &incoming.peer_id,
        &incoming.peer_name,
    )
    .await?;

    let account = account_or_placeholder(state);
    let new_voice = NewVoice {
        conversation_id,
        account_uin: account,
        msg_id: incoming.msg_id.clone(),
        msg_seq: incoming.msg_seq.clone(),
        sender_id: incoming.sender_id.clone(),
        sender_name: incoming.sender_name.clone(),
        sent_at: incoming.sent_at,
        duration_ms: incoming.segment.duration_ms,
        source: source.to_string(),
        magic: incoming.segment.magic,
        sha256: String::new(),
        record_file: incoming.segment.file.clone(),
        record_url: incoming.segment.url.clone(),
        record_path: incoming.segment.path.clone(),
    };

    let inserted = with_db(state, |conn| db::insert_voice(conn, &new_voice))?;
    let Some(voice_id) = inserted else {
        return Ok(None);
    };

    with_db(state, |conn| {
        db::recompute_conversation_stats(conn, conversation_id)
    })?;

    if state.settings_snapshot().collect.auto_collect {
        with_db(state, |conn| db::enqueue_job(conn, "download", voice_id))?;
    }

    let _ = tauri::Emitter::emit(
        app,
        EV_VOICES,
        serde_json::json!({ "conversationId": conversation_id, "voiceId": voice_id }),
    );
    let _ = tauri::Emitter::emit(app, EV_JOBS, serde_json::json!({ "reason": "enqueued" }));
    Ok(Some(voice_id))
}

/// 历史消息里的一条消息 → 语音模型。不是语音就返回 None。
fn history_message_to_voice(
    message: &serde_json::Value,
    kind: &str,
    peer_id: &str,
    peer_title: &str,
) -> Option<IncomingVoice> {
    let mut synthetic = message.clone();
    synthetic["post_type"] = serde_json::json!("message");
    synthetic["message_type"] =
        serde_json::json!(if kind == "group" { "group" } else { "private" });
    if kind == "group" {
        synthetic["group_id"] = serde_json::json!(peer_id);
        synthetic["group_name"] = serde_json::json!(peer_title);
    } else {
        synthetic["user_id"] = serde_json::json!(peer_id);
        synthetic["nickname"] = serde_json::json!(peer_title);
    }
    if synthetic.get("user_id").is_none() {
        if let Some(sender) = synthetic.get("sender") {
            synthetic["user_id"] = sender.get("user_id").cloned().unwrap_or_default();
        }
    }
    match napcat::parse_event(&synthetic) {
        Some(LiveEvent::Voice(voice)) => Some(*voice),
        _ => None,
    }
}

/// 回溯某个会话的历史语音。NapCat 的游标语义各版本略有差异，
/// 所以这里不赌「拿到空页才结束」，而是同时用去重与游标停滞判断。
pub async fn sync_history(
    app: &AppHandle,
    state: &Arc<Inner>,
    conversation_id: i64,
    max_pages: u32,
) -> AppResult<SyncReport> {
    let conversation = with_db(state, |conn| db::conversation(conn, conversation_id))?
        .ok_or_else(|| AppError::msg("会话不存在"))?;
    let settings = state.settings_snapshot();
    let api = client(state);
    let page_size = settings.collect.history_page_size.clamp(10, 100);
    let hard_limit = max_pages.min(settings.collect.max_history_pages).max(1);

    let mut report = SyncReport {
        conversations: 1,
        messages_scanned: 0,
        voices_found: 0,
        voices_saved: 0,
        pages: 0,
        stopped_reason: "reached_limit".into(),
    };

    let mut cursor = String::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();

    for page in 0..hard_limit {
        if state.is_stopping() {
            report.stopped_reason = "cancelled".into();
            break;
        }

        let messages = if conversation.kind == "group" {
            api.group_history(&conversation.peer_id, &cursor, page_size)
                .await?
        } else {
            api.friend_history(&conversation.peer_id, &cursor, page_size)
                .await?
        };

        report.pages = page as i64 + 1;
        if messages.is_empty() {
            report.stopped_reason = "no_more".into();
            break;
        }

        let mut oldest_id = String::new();
        let mut oldest_time = i64::MAX;
        let mut fresh_in_page = 0usize;

        for message in &messages {
            let msg_id = napcat::value_to_string(message.get("message_id"));
            if !msg_id.is_empty() && !seen.insert(msg_id.clone()) {
                continue;
            }
            fresh_in_page += 1;
            report.messages_scanned += 1;

            let sent_at = message
                .get("time")
                .and_then(|value| value.as_i64())
                .unwrap_or(0);
            if sent_at > 0 && sent_at < oldest_time {
                oldest_time = sent_at;
                oldest_id = msg_id.clone();
            } else if oldest_id.is_empty() && !msg_id.is_empty() {
                oldest_id = msg_id.clone();
            }

            if let Some(voice) = history_message_to_voice(
                message,
                &conversation.kind,
                &conversation.peer_id,
                &conversation.title,
            ) {
                report.voices_found += 1;
                match ingest_voice(app, state, voice, "history").await {
                    Ok(Some(_)) => report.voices_saved += 1,
                    Ok(None) => {}
                    Err(err) => {
                        tracing::warn!("历史语音入库失败：{err}");
                    }
                }
            }
        }

        state::progress(
            app,
            "sync",
            report.pages,
            hard_limit as i64,
            format!(
                "{} · 已扫描 {} 条消息",
                conversation.title, report.messages_scanned
            ),
            false,
        );

        if fresh_in_page == 0 {
            report.stopped_reason = "stalled".into();
            break;
        }
        if oldest_id.is_empty() || oldest_id == cursor {
            report.stopped_reason = "stalled".into();
            break;
        }
        cursor = oldest_id;
        if messages.len() < page_size as usize {
            report.stopped_reason = "no_more".into();
            break;
        }
    }

    with_db(state, |conn| {
        db::mark_conversation_synced(conn, conversation_id)?;
        db::recompute_conversation_stats(conn, conversation_id)
    })?;

    state::progress(
        app,
        "sync",
        report.pages,
        report.pages,
        "历史回溯完成",
        true,
    );
    let _ = tauri::Emitter::emit(app, EV_VOICES, serde_json::json!({ "reason": "history" }));
    Ok(report)
}

// ---------------------------------------------------------------------------
// 下载
// ---------------------------------------------------------------------------

struct DownloadOutcome {
    needs_decode: bool,
}

fn save_raw_bytes(
    library: &Path,
    sent_at: i64,
    stem: &str,
    bytes: &[u8],
    ext: &str,
) -> AppResult<PathBuf> {
    let dir = media::raw_dir(library, sent_at);
    std::fs::create_dir_all(&dir)?;
    let path = media::unique_path(&dir, stem, ext);
    std::fs::write(&path, bytes)?;
    Ok(path)
}

fn save_wav_bytes(
    library: &Path,
    sent_at: i64,
    stem: &str,
    bytes: &[u8],
    voice_id: i64,
) -> AppResult<(PathBuf, i64, i64, Vec<u8>)> {
    let wav = media::parse_wav(bytes)?;
    let dir = media::audio_dir(library, sent_at);
    std::fs::create_dir_all(&dir)?;
    let path = media::unique_path(&dir, stem, "wav");
    std::fs::write(&path, bytes)?;
    let peaks = media::peaks_from_wav(&wav, 96);
    tracing::debug!(
        "语音 {voice_id} 已保存：{} Hz / {} bit / {} 声道 → {}",
        wav.info.sample_rate,
        wav.info.bits_per_sample,
        wav.info.channels,
        path.display()
    );
    Ok((
        path,
        wav.info.sample_rate as i64,
        wav.info.duration_ms,
        peaks,
    ))
}

/// 下载一条语音：优先拿到 WAV；拿不到就归档 silk 原件，交给前端解码。
async fn download_voice(state: &Arc<Inner>, voice_id: i64) -> AppResult<DownloadOutcome> {
    let (source, settings) = {
        let conn = state.db();
        (
            db::voice_source(&conn, voice_id)?,
            state.settings_snapshot(),
        )
    };
    let source = source.ok_or_else(|| AppError::msg("语音记录已不存在"))?;

    if !source.file_path.is_empty() && Path::new(&source.file_path).is_file() {
        return Ok(DownloadOutcome {
            needs_decode: false,
        });
    }

    let library = PathBuf::from(&settings.library_dir);
    let stem = media::render_filename(
        &settings.naming.template,
        &source.sender_name,
        source.sent_at,
        source.duration_ms,
        &source.record_file,
    );
    let api = client(state);
    let http = state.http.clone();

    let mut wav_bytes: Option<Vec<u8>> = None;
    let mut raw_bytes: Option<(Vec<u8>, String)> = None;
    let mut last_error = String::new();

    // A. NapCat 与本应用同机时，消息段里的本地路径最快。
    if !source.record_path.is_empty() {
        match tokio::fs::read(&source.record_path).await {
            Ok(bytes) => {
                if media::is_wav(&bytes) {
                    wav_bytes = Some(bytes);
                } else if media::is_silk(&bytes) {
                    raw_bytes = Some((bytes, "silk".into()));
                }
            }
            Err(err) => last_error = format!("读取本地缓存失败：{err}"),
        }
    }

    // A2. 内嵌模式下，直接去引擎缓存里捞原件 —— 不依赖 NapCat 的 ffmpeg。
    if wav_bytes.is_none() && raw_bytes.is_none() && !source.record_file.is_empty() {
        let engine_dir = state.engine.rt().napcat_dir.clone();
        if !engine_dir.is_empty() {
            if let Some(path) =
                crate::engine::cached_audio(Path::new(&engine_dir), &source.record_file)
            {
                match tokio::fs::read(&path).await {
                    Ok(bytes) if media::is_wav(&bytes) => wav_bytes = Some(bytes),
                    Ok(bytes) if media::is_silk(&bytes) => raw_bytes = Some((bytes, "silk".into())),
                    Ok(_) => {}
                    Err(err) => tracing::debug!("读引擎缓存失败：{err}"),
                }
            }
        }
    }

    // B. 让 NapCat 转成 WAV。
    if wav_bytes.is_none() && !source.record_file.is_empty() {
        match api.record_path(&source.record_file, "wav").await {
            Ok(path) => match tokio::fs::read(&path).await {
                Ok(bytes) if media::is_wav(&bytes) => wav_bytes = Some(bytes),
                Ok(bytes) => {
                    if media::is_silk(&bytes) {
                        raw_bytes = Some((bytes, "silk".into()));
                    }
                }
                Err(err) => last_error = format!("NapCat 返回的路径读不到：{err}"),
            },
            Err(err) => last_error = err.to_string(),
        }
    }

    // C. 直接下载原始文件。
    if wav_bytes.is_none() && raw_bytes.is_none() && !source.record_url.is_empty() {
        match http.get(&source.record_url).send().await {
            Ok(response) if response.status().is_success() => {
                let bytes = response.bytes().await?.to_vec();
                if media::is_wav(&bytes) {
                    wav_bytes = Some(bytes);
                } else if media::is_silk(&bytes) {
                    raw_bytes = Some((bytes, "silk".into()));
                } else {
                    last_error = "下载到的文件既不是 WAV 也不是 SILK".into();
                }
            }
            Ok(response) => {
                last_error = format!("语音链接返回 HTTP {}", response.status().as_u16())
            }
            Err(err) => last_error = format!("下载语音失败：{err}"),
        }
    }

    if let Some(bytes) = wav_bytes {
        let (path, sample_rate, duration_ms, peaks) =
            save_wav_bytes(&library, source.sent_at, &stem, &bytes, voice_id)?;
        let size = bytes.len() as i64;
        let raw_path = if let Some((raw, ext)) = raw_bytes.as_ref() {
            if settings.collect.keep_raw {
                save_raw_bytes(&library, source.sent_at, &stem, raw, ext)?
                    .to_string_lossy()
                    .to_string()
            } else {
                String::new()
            }
        } else {
            String::new()
        };
        with_db(state, |conn| {
            db::set_voice_media(
                conn,
                voice_id,
                &db::VoiceMedia {
                    file_path: &path.to_string_lossy(),
                    raw_path: &raw_path,
                    size_bytes: size,
                    codec: "wav",
                    sample_rate,
                    duration_ms,
                },
            )?;
            db::set_voice_peaks(conn, voice_id, &peaks)?;
            db::set_voice_sha256(conn, voice_id, &media::sha256_bytes(&bytes))?;
            db::recompute_conversation_stats(conn, source.conversation_id)
        })?;
        return Ok(DownloadOutcome {
            needs_decode: false,
        });
    }

    if let Some((raw, ext)) = raw_bytes {
        let raw_path = save_raw_bytes(&library, source.sent_at, &stem, &raw, &ext)?;
        let size = raw.len() as i64;
        with_db(state, |conn| {
            db::set_voice_media(
                conn,
                voice_id,
                &db::VoiceMedia {
                    file_path: "",
                    raw_path: &raw_path.to_string_lossy(),
                    size_bytes: size,
                    codec: "silk",
                    sample_rate: 24_000,
                    duration_ms: 0,
                },
            )
        })?;
        return Ok(DownloadOutcome { needs_decode: true });
    }

    if last_error.is_empty() {
        Err(AppError::msg(
            "没有可用的语音来源（可能消息过旧，链接已失效）",
        ))
    } else {
        Err(AppError::msg(last_error))
    }
}

/// 把「有索引、没文件」的语音重新排队。重连、重启、引擎恢复后都该补一次。
pub fn requeue_missing(state: &Inner) -> AppResult<i64> {
    let conn = state.db();
    let ids = db::voices_missing_media(&conn, 500)?;
    for id in &ids {
        db::enqueue_job(&conn, "download", *id)?;
    }
    if !ids.is_empty() {
        tracing::info!("补下载 {} 条缺失语音", ids.len());
    }
    Ok(ids.len() as i64)
}

pub fn spawn_download_workers(app: AppHandle, state: Arc<Inner>) {
    let concurrency = state.settings_snapshot().collect.concurrency.clamp(1, 8);
    for index in 0..concurrency {
        let app = app.clone();
        let state = state.clone();
        tauri::async_runtime::spawn(async move {
            tracing::debug!("下载 worker #{index} 启动");
            loop {
                if state.is_stopping() {
                    break;
                }
                let job = with_db(&state, |conn| db::claim_job(conn, "download"));
                match job {
                    Ok(Some(job)) => {
                        let result = download_voice(&state, job.ref_id).await;
                        let error = result
                            .as_ref()
                            .err()
                            .map(|err| err.to_string())
                            .unwrap_or_default();
                        let status = if error.is_empty() { "done" } else { "failed" };
                        let _ =
                            with_db(&state, |conn| db::job_status(conn, job.id, status, &error));
                        if let Err(err) = &result {
                            tracing::warn!("语音 {} 下载失败：{err}", job.ref_id);
                            state::toast(&app, "error", format!("一条语音下载失败：{err}"));
                        } else if let Ok(outcome) = &result {
                            if outcome.needs_decode {
                                // 原件已归档，等前端用内置 SILK 解码器转成 WAV。
                                let _ = tauri::Emitter::emit(
                                    &app,
                                    "sylk://decode",
                                    serde_json::json!({ "voiceId": job.ref_id }),
                                );
                            }
                        }
                        let _ = tauri::Emitter::emit(
                            &app,
                            EV_VOICES,
                            serde_json::json!({ "reason": "downloaded", "voiceId": job.ref_id }),
                        );
                        let _ = tauri::Emitter::emit(&app, EV_JOBS, serde_json::json!({}));
                    }
                    Ok(None) => {
                        tokio::time::sleep(Duration::from_millis(1200)).await;
                    }
                    Err(err) => {
                        tracing::error!("任务队列读取失败：{err}");
                        tokio::time::sleep(Duration::from_secs(3)).await;
                    }
                }
            }
        });
    }
}

// ---------------------------------------------------------------------------
// 转写
// ---------------------------------------------------------------------------

async fn transcribe_voice(state: &Arc<Inner>, voice_id: i64) -> AppResult<()> {
    let (voice, settings) = {
        let conn = state.db();
        (db::voice(&conn, voice_id)?, state.settings_snapshot())
    };
    let voice = voice.ok_or_else(|| AppError::msg("语音记录已不存在"))?;
    if voice.file_path.is_empty() {
        return Err(AppError::msg("这条语音还没有可用的音频文件"));
    }
    if !settings.asr.enabled {
        return Err(AppError::msg("转写功能未启用"));
    }

    with_db(state, |conn| {
        db::set_transcript_status(conn, voice_id, "running", "")
    })?;

    let library = PathBuf::from(&settings.library_dir);
    let result = crate::asr::transcribe(&settings.asr, &library, Path::new(&voice.file_path)).await;

    match result {
        Ok(text) => {
            with_db(state, |conn| {
                db::set_voice_transcript(
                    conn,
                    voice_id,
                    &text,
                    &settings.asr.language,
                    &settings.asr.engine,
                )
            })?;
            Ok(())
        }
        Err(err) => {
            let _ = with_db(state, |conn| {
                db::set_transcript_status(conn, voice_id, "failed", &err.to_string())
            });
            Err(err)
        }
    }
}

pub fn spawn_transcribe_worker(app: AppHandle, state: Arc<Inner>) {
    tauri::async_runtime::spawn(async move {
        loop {
            if state.is_stopping() {
                break;
            }
            let job = with_db(&state, |conn| db::claim_job(conn, "transcribe"));
            match job {
                Ok(Some(job)) => {
                    let result = transcribe_voice(&state, job.ref_id).await;
                    let (status, error) = match &result {
                        Ok(_) => ("done", String::new()),
                        Err(err) => ("failed", err.to_string()),
                    };
                    let _ = with_db(&state, |conn| db::job_status(conn, job.id, status, &error));
                    if let Err(err) = result {
                        tracing::warn!("语音 {} 转写失败：{err}", job.ref_id);
                    }
                    let _ = tauri::Emitter::emit(
                        &app,
                        EV_VOICES,
                        serde_json::json!({ "reason": "transcribed", "voiceId": job.ref_id }),
                    );
                    let _ = tauri::Emitter::emit(&app, EV_JOBS, serde_json::json!({}));
                }
                Ok(None) => tokio::time::sleep(Duration::from_secs(2)).await,
                Err(err) => {
                    tracing::error!("转写队列读取失败：{err}");
                    tokio::time::sleep(Duration::from_secs(5)).await;
                }
            }
        }
    });
}

// ---------------------------------------------------------------------------
// 实时监听
// ---------------------------------------------------------------------------

pub fn spawn_live_listener(app: AppHandle, state: Arc<Inner>) {
    tauri::async_runtime::spawn(async move {
        let mut backoff = 1u64;
        loop {
            if state.is_stopping() {
                break;
            }
            let settings = state.settings_snapshot();
            if !settings.onboarded {
                // 还没走完引导就说明用户没确认过要接哪个账号，不擅自采集。
                tokio::time::sleep(Duration::from_secs(3)).await;
                continue;
            }
            let (_, ws_url, token) = state.napcat_endpoints();
            // token 走 Authorization 头，不拼 URL；query token 在新版 NapCat 会 400。
            let url = ws_url.clone();
            if url.trim().is_empty() || url == "ws://" || ws_url.trim().is_empty() {
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            }
            if !state.endpoints_ready() {
                // 引擎还没进入可登录状态，等它，而不是盲目重试。
                tokio::time::sleep(Duration::from_millis(1200)).await;
                continue;
            }

            let (tx, mut rx) = mpsc::unbounded_channel::<LiveEvent>();
            let pump_url = url.clone();
            let pump_token = token.clone();
            let pump = tauri::async_runtime::spawn(async move {
                let result = napcat::pump_once(&pump_url, &pump_token, |event| {
                    let _ = tx.send(event);
                })
                .await;
                result
            });

            let consumer_app = app.clone();
            let consumer_state = state.clone();
            let consumer = tauri::async_runtime::spawn(async move {
                while let Some(event) = rx.recv().await {
                    match event {
                        LiveEvent::Connected => {
                            if consumer_state.account_uin().is_empty() {
                                let _ = refresh_account(&consumer_state).await;
                            }
                            let mut conn_state = consumer_state.connection();
                            conn_state.live = true;
                            if conn_state.status == "idle" || conn_state.status == "error" {
                                conn_state.status = "online".into();
                                conn_state.message = "实时监听已连接".into();
                            }
                            consumer_state.set_connection(&consumer_app, conn_state);
                        }
                        LiveEvent::Voice(voice) => {
                            if let Err(err) =
                                ingest_voice(&consumer_app, &consumer_state, *voice, "live").await
                            {
                                tracing::warn!("实时语音入库失败：{err}");
                            }
                        }
                    }
                }
            });

            match pump.await {
                Ok(Ok(())) => {
                    let mut conn_state = state.connection();
                    conn_state.live = false;
                    state.set_connection(&app, conn_state);
                    backoff = 1;
                }
                Ok(Err(err)) => {
                    let mut conn_state = state.connection();
                    conn_state.live = false;
                    // 引擎还没起来时连不上是正常的，只在真正在线后失败才提示用户。
                    // 否则重启引擎的瞬间，界面上会闪过一条 "400 Bad Request"。
                    let ready = state.settings_snapshot().engine.mode == "external"
                        || state.engine.rt().phase == "online";
                    if ready {
                        conn_state.message = format!("实时监听断开，正在重连：{err}");
                        state.set_connection(&app, conn_state);
                    } else {
                        tracing::debug!("引擎未就绪，实时监听稍后重试：{err}");
                    }
                }
                Err(err) => {
                    tracing::warn!("监听任务异常：{err}");
                }
            }
            consumer.abort();

            // 配置可能被改过，重新读一遍再决定等待多久。
            let delay = backoff.min(30);
            tokio::time::sleep(Duration::from_secs(delay)).await;
            backoff = (backoff * 2).min(30);
        }
    });
}

/// 把「等待前端解码」的语音取出来。
pub fn pending_decode_ids(state: &Inner) -> AppResult<Vec<i64>> {
    let conn = state.db();
    let mut stmt = conn.prepare(
        "SELECT id FROM voices WHERE file_path = '' AND raw_path <> '' ORDER BY sent_at DESC LIMIT 200",
    )?;
    let rows = stmt
        .query_map([], |row| row.get::<_, i64>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

/// 由前端解码完成后调用：写入 16k/24k WAV 并补全元数据。
pub fn save_decoded_wav(
    state: &Inner,
    voice_id: i64,
    wav_bytes: &[u8],
    _declared_sample_rate: u32,
) -> AppResult<()> {
    let settings = state.settings_snapshot();
    let library = PathBuf::from(&settings.library_dir);
    let source = {
        let conn = state.db();
        db::voice_source(&conn, voice_id)?
    };
    let Some(source) = source else {
        return Err(AppError::msg("语音记录已不存在"));
    };
    let stem = media::render_filename(
        &settings.naming.template,
        &source.sender_name,
        source.sent_at,
        source.duration_ms,
        &source.record_file,
    );
    let (path, sample_rate, duration_ms, peaks) =
        save_wav_bytes(&library, source.sent_at, &stem, wav_bytes, voice_id)?;
    let size = wav_bytes.len() as i64;
    with_db(state, |conn| {
        db::set_voice_media(
            conn,
            voice_id,
            &db::VoiceMedia {
                file_path: &path.to_string_lossy(),
                raw_path: &source.raw_path,
                size_bytes: size,
                codec: "wav",
                sample_rate,
                duration_ms,
            },
        )?;
        db::set_voice_peaks(conn, voice_id, &peaks)?;
        db::recompute_conversation_stats(conn, source.conversation_id)
    })?;
    Ok(())
}

/// 连接成功后刷新账号信息。
pub async fn refresh_account(state: &Arc<Inner>) -> AppResult<crate::models::Account> {
    let api = client(state);
    let account = api.login_info().await?;
    with_db(state, |conn| {
        db::upsert_account(conn, &account.uin, &account.nickname, &account.avatar)
    })?;
    state.set_account(Some(account.clone()));
    Ok(account)
}

/// 设置里点了「测试连接」时调用。
pub async fn test_connection(state: &Arc<Inner>) -> AppResult<ConnectionState> {
    let mut next = ConnectionState {
        status: "connecting".into(),
        message: "正在连接 NapCat…".into(),
        ..Default::default()
    };
    let api = client(state);
    match api.login_info().await {
        Ok(account) => {
            let online = api.is_online().await;
            next.status = "online".into();
            next.message = if online {
                format!("已连接 {}（{}）", account.nickname, account.uin)
            } else {
                format!("已连接 {}，但 QQ 显示离线", account.nickname)
            };
            next.account = Some(account);
        }
        Err(err) => {
            next.status = "error".into();
            next.message = err.to_string();
        }
    }
    Ok(next)
}
