use std::path::Path;

use chrono::{Local, TimeZone};
use rusqlite::types::Value;
use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::error::{AppError, AppResult};
use crate::models::*;

// ---------------------------------------------------------------------------
// 建库
// ---------------------------------------------------------------------------

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS accounts (
    uin          TEXT PRIMARY KEY,
    nickname     TEXT NOT NULL DEFAULT '',
    avatar       TEXT NOT NULL DEFAULT '',
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    account_uin    TEXT NOT NULL,
    kind           TEXT NOT NULL CHECK (kind IN ('group', 'friend')),
    peer_id        TEXT NOT NULL,
    title          TEXT NOT NULL DEFAULT '',
    avatar         TEXT NOT NULL DEFAULT '',
    member_count   INTEGER NOT NULL DEFAULT 0,
    remark         TEXT NOT NULL DEFAULT '',
    voice_count    INTEGER NOT NULL DEFAULT 0,
    total_ms       INTEGER NOT NULL DEFAULT 0,
    last_voice_at  INTEGER,
    starred        INTEGER NOT NULL DEFAULT 0,
    synced_at      INTEGER,
    created_at     INTEGER NOT NULL,
    UNIQUE (account_uin, kind, peer_id)
);

CREATE TABLE IF NOT EXISTS voices (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id   INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    account_uin       TEXT NOT NULL,
    msg_id            TEXT NOT NULL,
    msg_seq           TEXT NOT NULL DEFAULT '',
    sender_id         TEXT NOT NULL DEFAULT '',
    sender_name       TEXT NOT NULL DEFAULT '',
    sent_at           INTEGER NOT NULL,
    duration_ms       INTEGER NOT NULL DEFAULT 0,
    size_bytes        INTEGER NOT NULL DEFAULT 0,
    codec             TEXT NOT NULL DEFAULT 'silk',
    sample_rate       INTEGER NOT NULL DEFAULT 0,
    file_path         TEXT NOT NULL DEFAULT '',
    raw_path          TEXT NOT NULL DEFAULT '',
    record_file       TEXT NOT NULL DEFAULT '',
    record_url        TEXT NOT NULL DEFAULT '',
    record_path       TEXT NOT NULL DEFAULT '',
    sha256            TEXT NOT NULL DEFAULT '',
    source            TEXT NOT NULL DEFAULT 'live',
    magic             INTEGER,
    transcript        TEXT NOT NULL DEFAULT '',
    transcript_lang   TEXT NOT NULL DEFAULT 'zh',
    transcript_status TEXT NOT NULL DEFAULT 'none',
    transcript_error  TEXT NOT NULL DEFAULT '',
    asr_engine        TEXT NOT NULL DEFAULT '',
    peaks             TEXT NOT NULL DEFAULT '[]',
    starred           INTEGER NOT NULL DEFAULT 0,
    note              TEXT NOT NULL DEFAULT '',
    tags              TEXT NOT NULL DEFAULT '[]',
    created_at        INTEGER NOT NULL,
    UNIQUE (account_uin, msg_id)
);

CREATE INDEX IF NOT EXISTS idx_voices_conv ON voices (conversation_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_voices_time ON voices (sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_voices_star ON voices (starred) WHERE starred = 1;
CREATE INDEX IF NOT EXISTS idx_voices_status ON voices (transcript_status);
CREATE INDEX IF NOT EXISTS idx_conv_recent ON conversations (last_voice_at DESC);

CREATE TABLE IF NOT EXISTS jobs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT NOT NULL,
    ref_id     INTEGER NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',
    attempts   INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (kind, ref_id)
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status, id);
"#;

pub fn open(path: &Path) -> AppResult<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "busy_timeout", 5000)?;
    conn.execute_batch(SCHEMA)?;
    // 上次退出时残留的 running 任务一律回到 pending。
    conn.execute(
        "UPDATE jobs SET status = 'pending' WHERE status = 'running'",
        [],
    )?;
    Ok(conn)
}

fn now() -> i64 {
    Local::now().timestamp()
}

// ---------------------------------------------------------------------------
// 账号
// ---------------------------------------------------------------------------

pub fn upsert_account(conn: &Connection, uin: &str, nickname: &str, avatar: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO accounts (uin, nickname, avatar, created_at, last_seen_at)
         VALUES (?1, ?2, ?3, ?4, ?4)
         ON CONFLICT(uin) DO UPDATE SET nickname = excluded.nickname,
                                        avatar = excluded.avatar,
                                        last_seen_at = excluded.last_seen_at",
        params![uin, nickname, avatar, now()],
    )?;
    Ok(())
}

pub fn get_account(conn: &Connection) -> AppResult<Option<Account>> {
    let row = conn
        .query_row(
            "SELECT uin, nickname, avatar FROM accounts ORDER BY last_seen_at DESC LIMIT 1",
            [],
            |row| {
                Ok(Account {
                    uin: row.get(0)?,
                    nickname: row.get(1)?,
                    avatar: row.get(2)?,
                    online: false,
                })
            },
        )
        .optional()?;
    Ok(row)
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

pub struct ConversationSeed {
    pub account_uin: String,
    pub kind: String,
    pub peer_id: String,
    pub title: String,
    pub avatar: String,
    pub member_count: i64,
}

pub fn upsert_conversations(conn: &mut Connection, seeds: &[ConversationSeed]) -> AppResult<i64> {
    let tx = conn.transaction()?;
    let mut count = 0i64;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO conversations (account_uin, kind, peer_id, title, avatar, member_count, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(account_uin, kind, peer_id) DO UPDATE SET
                title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE conversations.title END,
                avatar = CASE WHEN excluded.avatar <> '' THEN excluded.avatar ELSE conversations.avatar END,
                member_count = MAX(conversations.member_count, excluded.member_count)",
        )?;
        for seed in seeds {
            stmt.execute(params![
                seed.account_uin,
                seed.kind,
                seed.peer_id,
                seed.title,
                seed.avatar,
                seed.member_count,
                now()
            ])?;
            count += 1;
        }
    }
    tx.commit()?;
    Ok(count)
}

pub fn list_conversations(conn: &Connection, keyword: &str) -> AppResult<Vec<Conversation>> {
    let like = format!("%{}%", escape_like(keyword));
    let mut stmt = conn.prepare(
        "SELECT c.id, c.kind, c.peer_id, c.title, c.avatar, c.member_count, c.remark,
                c.voice_count, c.total_ms, c.last_voice_at, c.starred, c.synced_at
         FROM conversations c
         WHERE (?1 = '%%' OR c.title LIKE ?1 ESCAPE '\\' OR c.remark LIKE ?1 ESCAPE '\\' OR c.peer_id LIKE ?1 ESCAPE '\\')
         ORDER BY (c.last_voice_at IS NULL), c.last_voice_at DESC, c.title COLLATE NOCASE ASC",
    )?;
    let rows = stmt
        .query_map(params![like], |row| {
            Ok(Conversation {
                id: row.get(0)?,
                kind: row.get(1)?,
                peer_id: row.get(2)?,
                title: row.get(3)?,
                avatar: row.get(4)?,
                member_count: row.get(5)?,
                remark: row.get(6)?,
                voice_count: row.get(7)?,
                total_ms: row.get(8)?,
                last_voice_at: row.get(9)?,
                starred: row.get::<_, i64>(10)? != 0,
                synced_at: row.get(11)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn conversation(conn: &Connection, id: i64) -> AppResult<Option<Conversation>> {
    let row = conn
        .query_row(
            "SELECT id, kind, peer_id, title, avatar, member_count, remark, voice_count,
                    total_ms, last_voice_at, starred, synced_at
             FROM conversations WHERE id = ?1",
            params![id],
            |row| {
                Ok(Conversation {
                    id: row.get(0)?,
                    kind: row.get(1)?,
                    peer_id: row.get(2)?,
                    title: row.get(3)?,
                    avatar: row.get(4)?,
                    member_count: row.get(5)?,
                    remark: row.get(6)?,
                    voice_count: row.get(7)?,
                    total_ms: row.get(8)?,
                    last_voice_at: row.get(9)?,
                    starred: row.get::<_, i64>(10)? != 0,
                    synced_at: row.get(11)?,
                })
            },
        )
        .optional()?;
    Ok(row)
}

pub fn find_conversation(
    conn: &Connection,
    account_uin: &str,
    kind: &str,
    peer_id: &str,
) -> AppResult<Option<i64>> {
    let id = conn
        .query_row(
            "SELECT id FROM conversations WHERE account_uin = ?1 AND kind = ?2 AND peer_id = ?3",
            params![account_uin, kind, peer_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    Ok(id)
}

/// 插入单个会话（实时收到陌生会话的消息时用），已存在则返回其 id。
pub fn insert_conversation(conn: &Connection, seed: &ConversationSeed) -> AppResult<i64> {
    conn.execute(
        "INSERT INTO conversations (account_uin, kind, peer_id, title, avatar, member_count, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(account_uin, kind, peer_id) DO UPDATE SET
            title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE conversations.title END,
            avatar = CASE WHEN excluded.avatar <> '' THEN excluded.avatar ELSE conversations.avatar END",
        params![
            seed.account_uin,
            seed.kind,
            seed.peer_id,
            seed.title,
            seed.avatar,
            seed.member_count,
            now()
        ],
    )?;
    let id = find_conversation(conn, &seed.account_uin, &seed.kind, &seed.peer_id)?
        .ok_or_else(|| AppError::msg("会话写入后未能读回"))?;
    Ok(id)
}

pub fn set_conversation_remark(conn: &Connection, id: i64, remark: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE conversations SET remark = ?2 WHERE id = ?1",
        params![id, remark],
    )?;
    Ok(())
}

pub fn set_conversation_star(conn: &Connection, id: i64, starred: bool) -> AppResult<()> {
    conn.execute(
        "UPDATE conversations SET starred = ?2 WHERE id = ?1",
        params![id, if starred { 1 } else { 0 }],
    )?;
    Ok(())
}

pub fn mark_conversation_synced(conn: &Connection, id: i64) -> AppResult<()> {
    conn.execute(
        "UPDATE conversations SET synced_at = ?2 WHERE id = ?1",
        params![id, now()],
    )?;
    Ok(())
}

pub fn recompute_conversation_stats(conn: &Connection, conversation_id: i64) -> AppResult<()> {
    conn.execute(
        "UPDATE conversations SET
            voice_count = (SELECT COUNT(*) FROM voices WHERE conversation_id = ?1),
            total_ms = (SELECT COALESCE(SUM(duration_ms), 0) FROM voices WHERE conversation_id = ?1),
            last_voice_at = (SELECT MAX(sent_at) FROM voices WHERE conversation_id = ?1)
         WHERE id = ?1",
        params![conversation_id],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// 语音
// ---------------------------------------------------------------------------

pub struct NewVoice {
    pub conversation_id: i64,
    pub account_uin: String,
    pub msg_id: String,
    pub msg_seq: String,
    pub sender_id: String,
    pub sender_name: String,
    pub sent_at: i64,
    pub duration_ms: i64,
    pub source: String,
    pub magic: Option<i64>,
    pub sha256: String,
    pub record_file: String,
    pub record_url: String,
    pub record_path: String,
}

/// 返回新插入的 id；已存在则返回 None（靠 UNIQUE 约束去重）。
pub fn insert_voice(conn: &Connection, voice: &NewVoice) -> AppResult<Option<i64>> {
    let changed = conn.execute(
        "INSERT OR IGNORE INTO voices
            (conversation_id, account_uin, msg_id, msg_seq, sender_id, sender_name,
             sent_at, duration_ms, source, magic, sha256, record_file, record_url,
             record_path, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        params![
            voice.conversation_id,
            voice.account_uin,
            voice.msg_id,
            voice.msg_seq,
            voice.sender_id,
            voice.sender_name,
            voice.sent_at,
            voice.duration_ms,
            voice.source,
            voice.magic,
            voice.sha256,
            voice.record_file,
            voice.record_url,
            voice.record_path,
            now()
        ],
    )?;
    if changed == 0 {
        return Ok(None);
    }
    Ok(Some(conn.last_insert_rowid()))
}

/// 下载任务需要的原始引用。
pub struct VoiceSource {
    pub conversation_id: i64,
    pub record_file: String,
    pub record_url: String,
    pub record_path: String,
    pub raw_path: String,
    pub file_path: String,
    pub duration_ms: i64,
    pub sent_at: i64,
    pub sender_name: String,
}

pub fn voice_source(conn: &Connection, id: i64) -> AppResult<Option<VoiceSource>> {
    let row = conn
        .query_row(
            "SELECT conversation_id, record_file, record_url, record_path, raw_path,
                    file_path, duration_ms, sent_at, sender_name
             FROM voices WHERE id = ?1",
            params![id],
            |row| {
                Ok(VoiceSource {
                    conversation_id: row.get(0)?,
                    record_file: row.get(1)?,
                    record_url: row.get(2)?,
                    record_path: row.get(3)?,
                    raw_path: row.get(4)?,
                    file_path: row.get(5)?,
                    duration_ms: row.get(6)?,
                    sent_at: row.get(7)?,
                    sender_name: row.get(8)?,
                })
            },
        )
        .optional()?;
    Ok(row)
}

pub fn voice(conn: &Connection, id: i64) -> AppResult<Option<Voice>> {
    let row = conn
        .query_row(
            &format!("{VOICE_SELECT} WHERE v.id = ?1"),
            params![id],
            map_voice,
        )
        .optional()?;
    Ok(row)
}

pub struct VoiceMedia<'a> {
    pub file_path: &'a str,
    pub raw_path: &'a str,
    pub size_bytes: i64,
    pub codec: &'a str,
    pub sample_rate: i64,
    pub duration_ms: i64,
}

pub fn set_voice_media(conn: &Connection, id: i64, media: &VoiceMedia<'_>) -> AppResult<()> {
    conn.execute(
        "UPDATE voices SET file_path = ?2, raw_path = ?3, size_bytes = ?4, codec = ?5,
                          sample_rate = ?6, duration_ms = MAX(duration_ms, ?7)
         WHERE id = ?1",
        params![
            id,
            media.file_path,
            media.raw_path,
            media.size_bytes,
            media.codec,
            media.sample_rate,
            media.duration_ms
        ],
    )?;
    Ok(())
}

pub fn set_voice_sha256(conn: &Connection, id: i64, digest: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE voices SET sha256 = ?2 WHERE id = ?1",
        params![id, digest],
    )?;
    Ok(())
}

pub fn set_voice_peaks(conn: &Connection, id: i64, peaks: &[u8]) -> AppResult<()> {
    conn.execute(
        "UPDATE voices SET peaks = ?2 WHERE id = ?1",
        params![id, serde_json::to_string(peaks)?],
    )?;
    Ok(())
}

pub fn set_voice_transcript(
    conn: &Connection,
    id: i64,
    text: &str,
    lang: &str,
    engine: &str,
) -> AppResult<()> {
    conn.execute(
        "UPDATE voices SET transcript = ?2, transcript_lang = ?3, asr_engine = ?4,
                          transcript_status = 'done', transcript_error = ''
         WHERE id = ?1",
        params![id, text, lang, engine],
    )?;
    Ok(())
}

pub fn set_transcript_status(
    conn: &Connection,
    id: i64,
    status: &str,
    error: &str,
) -> AppResult<()> {
    conn.execute(
        "UPDATE voices SET transcript_status = ?2, transcript_error = ?3 WHERE id = ?1",
        params![id, status, error],
    )?;
    Ok(())
}

pub fn set_voice_flags(
    conn: &Connection,
    id: i64,
    starred: bool,
    note: &str,
    tags: &[String],
) -> AppResult<()> {
    conn.execute(
        "UPDATE voices SET starred = ?2, note = ?3, tags = ?4 WHERE id = ?1",
        params![
            id,
            if starred { 1 } else { 0 },
            note,
            serde_json::to_string(tags)?
        ],
    )?;
    Ok(())
}

pub fn delete_voice(conn: &Connection, id: i64) -> AppResult<()> {
    let conv: Option<i64> = conn
        .query_row(
            "SELECT conversation_id FROM voices WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .optional()?;
    conn.execute("DELETE FROM voices WHERE id = ?1", params![id])?;
    conn.execute(
        "DELETE FROM jobs WHERE kind IN ('download','transcribe') AND ref_id = ?1",
        params![id],
    )?;
    if let Some(conv) = conv {
        recompute_conversation_stats(conn, conv)?;
    }
    Ok(())
}

const VOICE_SELECT: &str = "SELECT v.id, v.conversation_id, v.msg_id, v.sender_id, v.sender_name,
        v.sent_at, v.duration_ms, v.size_bytes, v.codec, v.sample_rate, v.file_path,
        v.source, v.transcript, v.transcript_status, v.transcript_error, v.asr_engine,
        v.peaks, v.starred, v.note, v.tags, c.title, c.kind, v.raw_path
 FROM voices v JOIN conversations c ON c.id = v.conversation_id";

fn map_voice(row: &Row<'_>) -> rusqlite::Result<Voice> {
    let file_path: String = row.get(10)?;
    let raw_path: String = row.get(22)?;
    let peaks_raw: String = row.get(16)?;
    let tags_raw: String = row.get(19)?;
    Ok(Voice {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        msg_id: row.get(2)?,
        sender_id: row.get(3)?,
        sender_name: row.get(4)?,
        sent_at: row.get(5)?,
        duration_ms: row.get(6)?,
        size_bytes: row.get(7)?,
        codec: row.get(8)?,
        sample_rate: row.get(9)?,
        playable: !file_path.is_empty() && std::path::Path::new(&file_path).is_file(),
        file_path,
        raw_path,
        source: row.get(11)?,
        transcript: row.get(12)?,
        transcript_status: row.get(13)?,
        transcript_error: row.get(14)?,
        asr_engine: row.get(15)?,
        peaks: serde_json::from_str(&peaks_raw).unwrap_or_default(),
        starred: row.get::<_, i64>(17)? != 0,
        note: row.get(18)?,
        tags: serde_json::from_str(&tags_raw).unwrap_or_default(),
        conversation_title: row.get(20)?,
        conversation_kind: row.get(21)?,
    })
}

pub fn query_voices(conn: &Connection, query: &VoiceQuery) -> AppResult<VoicePage> {
    let mut where_sql = String::from(" WHERE 1 = 1");
    let mut args: Vec<Value> = Vec::new();

    if let Some(conv) = query.conversation_id {
        where_sql.push_str(" AND v.conversation_id = ?");
        args.push(Value::Integer(conv));
    }
    if query.only_starred {
        where_sql.push_str(" AND v.starred = 1");
    }
    if query.only_transcribed {
        where_sql.push_str(" AND v.transcript_status = 'done' AND v.transcript <> ''");
    }
    if !query.sender_id.trim().is_empty() {
        where_sql.push_str(" AND v.sender_id = ?");
        args.push(Value::Text(query.sender_id.trim().to_string()));
    }
    if let Some(from) = query.from {
        where_sql.push_str(" AND v.sent_at >= ?");
        args.push(Value::Integer(from));
    }
    if let Some(to) = query.to {
        where_sql.push_str(" AND v.sent_at <= ?");
        args.push(Value::Integer(to));
    }
    let keyword = query.keyword.trim();
    if !keyword.is_empty() {
        where_sql.push_str(
            " AND (v.transcript LIKE ? ESCAPE '\\' OR v.sender_name LIKE ? ESCAPE '\\'
                   OR v.note LIKE ? ESCAPE '\\' OR c.title LIKE ? ESCAPE '\\' OR v.tags LIKE ? ESCAPE '\\')",
        );
        let pattern = format!("%{}%", escape_like(keyword));
        for _ in 0..5 {
            args.push(Value::Text(pattern.clone()));
        }
    }

    let count_sql = format!(
        "SELECT COUNT(*) FROM voices v JOIN conversations c ON c.id = v.conversation_id{where_sql}"
    );
    let total: i64 =
        conn.query_row(&count_sql, rusqlite::params_from_iter(args.iter()), |row| {
            row.get(0)
        })?;

    let limit = query.limit.clamp(1, 1000) as i64;
    let offset = query.offset as i64;
    let list_sql =
        format!("{VOICE_SELECT}{where_sql} ORDER BY v.sent_at DESC, v.id DESC LIMIT ? OFFSET ?");
    let mut list_args = args.clone();
    list_args.push(Value::Integer(limit));
    list_args.push(Value::Integer(offset));

    let mut stmt = conn.prepare(&list_sql)?;
    let items = stmt
        .query_map(rusqlite::params_from_iter(list_args.iter()), map_voice)?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(VoicePage { items, total })
}

pub fn voices_missing_media(conn: &Connection, limit: u32) -> AppResult<Vec<i64>> {
    let mut stmt =
        conn.prepare("SELECT id FROM voices WHERE file_path = '' ORDER BY sent_at DESC LIMIT ?1")?;
    let rows = stmt
        .query_map(params![limit], |row| row.get::<_, i64>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn voices_for_transcribe(conn: &Connection, limit: u32) -> AppResult<Vec<i64>> {
    let mut stmt = conn.prepare(
        "SELECT id FROM voices
         WHERE file_path <> '' AND transcript_status IN ('none', 'failed', 'queued')
         ORDER BY sent_at DESC LIMIT ?1",
    )?;
    let rows = stmt
        .query_map(params![limit], |row| row.get::<_, i64>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

// ---------------------------------------------------------------------------
// 任务队列
// ---------------------------------------------------------------------------

pub fn enqueue_job(conn: &Connection, kind: &str, ref_id: i64) -> AppResult<()> {
    let ts = now();
    conn.execute(
        "INSERT INTO jobs (kind, ref_id, status, created_at, updated_at)
         VALUES (?1, ?2, 'pending', ?3, ?3)
         ON CONFLICT(kind, ref_id) DO UPDATE SET
            status = CASE WHEN jobs.status = 'done' THEN jobs.status ELSE 'pending' END,
            updated_at = excluded.updated_at",
        params![kind, ref_id, ts],
    )?;
    Ok(())
}

pub fn next_job(conn: &Connection, kind: &str) -> AppResult<Option<Job>> {
    let row = conn
        .query_row(
            "SELECT j.id, j.kind, j.ref_id, j.status, j.attempts, j.last_error, j.created_at,
                    j.updated_at, COALESCE(c.title, '')
             FROM jobs j
             LEFT JOIN voices v ON v.id = j.ref_id
             LEFT JOIN conversations c ON c.id = v.conversation_id
             WHERE j.kind = ?1 AND j.status IN ('pending', 'failed') AND j.attempts < 3
             ORDER BY j.id ASC LIMIT 1",
            params![kind],
            |row| {
                Ok(Job {
                    id: row.get(0)?,
                    kind: row.get(1)?,
                    ref_id: row.get(2)?,
                    status: row.get(3)?,
                    attempts: row.get(4)?,
                    last_error: row.get(5)?,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                    title: row.get(8)?,
                })
            },
        )
        .optional()?;
    Ok(row)
}

pub fn job_status(conn: &Connection, id: i64, status: &str, error: &str) -> AppResult<()> {
    conn.execute(
        "UPDATE jobs SET status = ?2, last_error = ?3, updated_at = ?4,
                        attempts = attempts + CASE WHEN ?2 = 'failed' THEN 1 ELSE 0 END
         WHERE id = ?1",
        params![id, status, error, now()],
    )?;
    Ok(())
}

/// 取一条待办并原子地标记为 running，避免多个 worker 抢同一条。
pub fn claim_job(conn: &Connection, kind: &str) -> AppResult<Option<Job>> {
    let Some(job) = next_job(conn, kind)? else {
        return Ok(None);
    };
    let updated = conn.execute(
        "UPDATE jobs SET status = 'running', updated_at = ?2
         WHERE id = ?1 AND status IN ('pending', 'failed')",
        params![job.id, now()],
    )?;
    if updated == 0 {
        return Ok(None);
    }
    Ok(Some(job))
}

pub fn list_jobs(conn: &Connection, limit: u32) -> AppResult<Vec<Job>> {
    let mut stmt = conn.prepare(
        "SELECT j.id, j.kind, j.ref_id, j.status, j.attempts, j.last_error, j.created_at,
                j.updated_at, COALESCE(c.title, '')
         FROM jobs j
         LEFT JOIN voices v ON v.id = j.ref_id
         LEFT JOIN conversations c ON c.id = v.conversation_id
         WHERE j.status IN ('pending', 'running', 'failed')
         ORDER BY j.id DESC LIMIT ?1",
    )?;
    let rows = stmt
        .query_map(params![limit], |row| {
            Ok(Job {
                id: row.get(0)?,
                kind: row.get(1)?,
                ref_id: row.get(2)?,
                status: row.get(3)?,
                attempts: row.get(4)?,
                last_error: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
                title: row.get(8)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

pub fn clear_finished_jobs(conn: &Connection) -> AppResult<()> {
    conn.execute("DELETE FROM jobs WHERE status IN ('done')", [])?;
    Ok(())
}

pub fn retry_failed_jobs(conn: &Connection) -> AppResult<()> {
    conn.execute(
        "UPDATE jobs SET status = 'pending', attempts = 0, last_error = '', updated_at = ?1
         WHERE status = 'failed'",
        params![now()],
    )?;
    Ok(())
}

pub fn job_counts(conn: &Connection) -> AppResult<(i64, i64)> {
    let pending: i64 = conn.query_row(
        "SELECT COUNT(*) FROM jobs WHERE status IN ('pending', 'running')",
        [],
        |row| row.get(0),
    )?;
    let failed: i64 = conn.query_row(
        "SELECT COUNT(*) FROM jobs WHERE status = 'failed'",
        [],
        |row| row.get(0),
    )?;
    Ok((pending, failed))
}

// ---------------------------------------------------------------------------
// 统计
// ---------------------------------------------------------------------------

pub fn overview(conn: &Connection) -> AppResult<Overview> {
    let today_start = Local::now()
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .and_then(|naive| Local.from_local_datetime(&naive).single())
        .map(|dt| dt.timestamp())
        .unwrap_or(0);

    let (pending, failed) = job_counts(conn)?;

    let row = conn.query_row(
        "SELECT
            (SELECT COUNT(*) FROM voices),
            (SELECT COALESCE(SUM(duration_ms), 0) FROM voices),
            (SELECT COUNT(*) FROM conversations WHERE voice_count > 0),
            (SELECT COUNT(*) FROM voices WHERE transcript_status = 'done' AND transcript <> ''),
            (SELECT COALESCE(SUM(size_bytes), 0) FROM voices),
            (SELECT COUNT(*) FROM voices WHERE sent_at >= ?1),
            (SELECT COUNT(*) FROM voices WHERE starred = 1)",
        params![today_start],
        |row| {
            Ok(Overview {
                voices: row.get(0)?,
                total_ms: row.get(1)?,
                conversations: row.get(2)?,
                transcribed: row.get(3)?,
                storage_bytes: row.get(4)?,
                today: row.get(5)?,
                starred: row.get(6)?,
                pending_jobs: pending,
                failed_jobs: failed,
            })
        },
    )?;
    Ok(row)
}

pub fn stats(conn: &Connection) -> AppResult<StatsBundle> {
    let overview = overview(conn)?;

    let mut stmt = conn.prepare(
        "SELECT c.id, c.title, c.kind, c.avatar, c.voice_count, c.total_ms
         FROM conversations c WHERE c.voice_count > 0
         ORDER BY c.total_ms DESC LIMIT 8",
    )?;
    let top_conversations = stmt
        .query_map([], |row| {
            Ok(ConversationStat {
                id: row.get(0)?,
                title: row.get(1)?,
                kind: row.get(2)?,
                avatar: row.get(3)?,
                voices: row.get(4)?,
                total_ms: row.get(5)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut stmt = conn.prepare(
        "SELECT sender_id, sender_name, COUNT(*) AS n, COALESCE(SUM(duration_ms), 0) AS ms
         FROM voices GROUP BY sender_id, sender_name ORDER BY ms DESC LIMIT 10",
    )?;
    let top_senders = stmt
        .query_map([], |row| {
            Ok(SenderStat {
                sender_id: row.get(0)?,
                name: row.get(1)?,
                voices: row.get(2)?,
                total_ms: row.get(3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut stmt = conn.prepare(
        "SELECT ((CAST(strftime('%w', sent_at, 'unixepoch', 'localtime') AS INTEGER) + 6) % 7) AS wd,
                CAST(strftime('%H', sent_at, 'unixepoch', 'localtime') AS INTEGER) AS hr,
                COUNT(*)
         FROM voices GROUP BY wd, hr",
    )?;
    let heatmap = stmt
        .query_map([], |row| {
            Ok(HeatCell {
                weekday: row.get(0)?,
                hour: row.get(1)?,
                count: row.get(2)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let since = Local::now().timestamp() - 29 * 86_400;
    let mut stmt = conn.prepare(
        "SELECT strftime('%Y-%m-%d', sent_at, 'unixepoch', 'localtime') AS d, COUNT(*)
         FROM voices WHERE sent_at >= ?1 GROUP BY d ORDER BY d ASC",
    )?;
    let daily = stmt
        .query_map(params![since], |row| {
            Ok(DayCount {
                day: row.get(0)?,
                count: row.get(1)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(StatsBundle {
        overview,
        top_conversations,
        top_senders,
        heatmap,
        daily,
    })
}

// ---------------------------------------------------------------------------
// 维护
// ---------------------------------------------------------------------------

pub fn wipe_archive(conn: &Connection) -> AppResult<()> {
    conn.execute_batch("DELETE FROM jobs; DELETE FROM voices; DELETE FROM conversations; VACUUM;")?;
    Ok(())
}

fn escape_like(input: &str) -> String {
    input
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// 给导出模块复用：把一组语音按时间顺序取出。
pub fn voices_of_conversation(conn: &Connection, conversation_id: i64) -> AppResult<Vec<Voice>> {
    let mut stmt = conn.prepare(&format!(
        "{VOICE_SELECT} WHERE v.conversation_id = ?1 ORDER BY v.sent_at ASC, v.id ASC"
    ))?;
    let rows = stmt
        .query_map(params![conversation_id], map_voice)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}
