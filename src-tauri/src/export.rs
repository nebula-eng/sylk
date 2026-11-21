use std::fs;
use std::path::{Path, PathBuf};

use chrono::{Local, TimeZone};

use crate::error::{AppError, AppResult};
use crate::media;
use crate::models::{Conversation, ExportReport, Voice};

fn fmt_time(sent_at: i64) -> String {
    Local
        .timestamp_opt(sent_at, 0)
        .single()
        .unwrap_or_else(Local::now)
        .format("%Y-%m-%d %H:%M:%S")
        .to_string()
}

fn fmt_duration(ms: i64) -> String {
    let total = (ms / 1000).max(0);
    format!("{}:{:02}", total / 60, total % 60)
}

fn csv_escape(value: &str) -> String {
    if value.contains(',') || value.contains('"') || value.contains('\n') || value.contains('\r') {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

fn html_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// 导出一个会话的完整档案：音频 + JSON 清单 + 文字稿 + CSV + 可离线打开的 HTML。
pub fn export_conversation(
    base_dir: &Path,
    conversation: &Conversation,
    voices: &[Voice],
) -> AppResult<ExportReport> {
    let safe_title = media::sanitize_component(&conversation.title);
    let folder_name = if safe_title.is_empty() {
        format!("{}-{}", conversation.kind, conversation.peer_id)
    } else {
        safe_title
    };
    let root = unique_dir(base_dir, &folder_name);
    let audio_dir = root.join("audio");
    fs::create_dir_all(&audio_dir)?;

    let mut files = 0i64;
    let mut bytes = 0i64;
    let mut manifest_items: Vec<serde_json::Value> = Vec::new();
    let mut html_rows = String::new();
    let mut transcript_md = String::new();
    let mut csv = String::from("时间,发送者,时长(秒),文件名,转写,标签,星标,备注\n");

    transcript_md.push_str(&format!("# {}\n\n", conversation.title));
    transcript_md.push_str(&format!(
        "> 由 Sylk 导出于 {} · 共 {} 条语音\n\n",
        fmt_time(Local::now().timestamp()),
        voices.len()
    ));

    for voice in voices {
        let mut relative = String::new();
        if !voice.file_path.is_empty() && Path::new(&voice.file_path).is_file() {
            let ext = Path::new(&voice.file_path)
                .extension()
                .map(|value| value.to_string_lossy().to_string())
                .unwrap_or_else(|| "wav".into());
            let stem = media::render_filename(
                "{date}_{time}_{sender}",
                &voice.sender_name,
                voice.sent_at,
                voice.duration_ms,
                &voice.msg_id,
            );
            let target = media::unique_path(&audio_dir, &stem, &ext);
            fs::copy(&voice.file_path, &target)?;
            bytes += fs::metadata(&target)
                .map(|meta| meta.len() as i64)
                .unwrap_or(0);
            files += 1;
            relative = format!(
                "audio/{}",
                target
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_default()
            );
        }

        let time_text = fmt_time(voice.sent_at);
        let tags = voice.tags.join(" / ");
        csv.push_str(&format!(
            "{},{},{:.1},{},{},{},{},{}\n",
            csv_escape(&time_text),
            csv_escape(&voice.sender_name),
            voice.duration_ms as f64 / 1000.0,
            csv_escape(&relative),
            csv_escape(&voice.transcript),
            csv_escape(&tags),
            if voice.starred { "是" } else { "" },
            csv_escape(&voice.note),
        ));

        let transcript_line = if voice.transcript.is_empty() {
            "（未转写）".to_string()
        } else {
            voice.transcript.clone()
        };
        transcript_md.push_str(&format!(
            "### {} · {}\n\n{}\n\n",
            time_text, voice.sender_name, transcript_line
        ));

        let audio_tag = if relative.is_empty() {
            "<span class=\"missing\">无音频</span>".to_string()
        } else {
            format!(
                "<audio controls preload=\"none\" src=\"{}\"></audio>",
                html_escape(&relative)
            )
        };
        html_rows.push_str(&format!(
            "<article class=\"item\">\n  <header><strong>{}</strong><span>{}</span><time>{}</time></header>\n  <p class=\"text\">{}</p>\n  {}\n</article>\n",
            html_escape(if voice.sender_name.is_empty() { "未知" } else { &voice.sender_name }),
            html_escape(&fmt_duration(voice.duration_ms)),
            html_escape(&time_text),
            html_escape(&transcript_line),
            audio_tag,
        ));

        manifest_items.push(serde_json::json!({
            "id": voice.id,
            "time": time_text,
            "timestamp": voice.sent_at,
            "senderId": voice.sender_id,
            "sender": voice.sender_name,
            "durationMs": voice.duration_ms,
            "file": relative,
            "transcript": voice.transcript,
            "tags": voice.tags,
            "starred": voice.starred,
            "note": voice.note,
            "source": voice.source,
        }));
    }

    let manifest = serde_json::json!({
        "app": "Sylk",
        "version": env!("CARGO_PKG_VERSION"),
        "exportedAt": fmt_time(Local::now().timestamp()),
        "conversation": {
            "kind": conversation.kind,
            "peerId": conversation.peer_id,
            "title": conversation.title,
            "voiceCount": voices.len(),
        },
        "voices": manifest_items,
    });
    fs::write(
        root.join("manifest.json"),
        serde_json::to_string_pretty(&manifest)?,
    )?;
    files += 1;
    fs::write(root.join("transcript.md"), transcript_md)?;
    files += 1;
    fs::write(root.join("index.csv"), format!("\u{feff}{csv}"))?;
    files += 1;
    fs::write(
        root.join("archive.html"),
        render_html(&conversation.title, voices.len(), &html_rows),
    )?;
    files += 1;

    Ok(ExportReport {
        path: root.to_string_lossy().to_string(),
        files,
        bytes,
    })
}

fn unique_dir(base: &Path, name: &str) -> PathBuf {
    let mut candidate = base.join(name);
    let mut index = 2;
    while candidate.exists() {
        candidate = base.join(format!("{name}-{index}"));
        index += 1;
        if index > 999 {
            break;
        }
    }
    candidate
}

fn render_html(title: &str, count: usize, rows: &str) -> String {
    format!(
        r#"<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>{title} · Sylk 导出</title>
<style>
  :root {{
    color-scheme: light;
    --bg: #f7f8fa; --surface: #fff; --border: #e3e7ef; --text: #131722; --muted: #6a7488; --accent: #3e63dd;
  }}
  * {{ box-sizing: border-box; }}
  body {{ margin: 0; background: var(--bg); color: var(--text);
    font: 15px/1.65 ui-sans-serif, system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }}
  main {{ max-width: 860px; margin: 0 auto; padding: 48px 24px 96px; }}
  h1 {{ font-size: 26px; margin: 0 0 6px; letter-spacing: -0.01em; }}
  .meta {{ color: var(--muted); font-size: 13px; margin-bottom: 28px; }}
  .item {{ background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
    padding: 16px 18px; margin-bottom: 12px; }}
  .item header {{ display: flex; align-items: baseline; gap: 10px; font-size: 13px; color: var(--muted); }}
  .item header strong {{ color: var(--text); font-size: 14px; }}
  .item header time {{ margin-left: auto; font-variant-numeric: tabular-nums; }}
  .text {{ margin: 8px 0 10px; white-space: pre-wrap; word-break: break-word; }}
  audio {{ width: 100%; height: 34px; }}
  .missing {{ font-size: 12px; color: #b45309; }}
  footer {{ margin-top: 40px; font-size: 12px; color: var(--muted); text-align: center; }}
</style>
</head>
<body>
<main>
  <h1>{title}</h1>
  <div class="meta">共 {count} 条语音 · 由 Sylk 归档导出 · 音频与文字均保存在本地</div>
  {rows}
  <footer>本页面可离线打开，音频路径相对于 archive.html。</footer>
</main>
</body>
</html>"#,
        title = html_escape(title),
        count = count,
        rows = rows,
    )
}

/// 导出任意查询结果为 CSV（用于「导出当前筛选」）。
pub fn export_csv(path: &Path, voices: &[Voice]) -> AppResult<ExportReport> {
    let mut csv = String::from("会话,时间,发送者,时长(秒),转写,标签,星标,备注\n");
    for voice in voices {
        csv.push_str(&format!(
            "{},{},{},{:.1},{},{},{},{}\n",
            csv_escape(&voice.conversation_title),
            csv_escape(&fmt_time(voice.sent_at)),
            csv_escape(&voice.sender_name),
            voice.duration_ms as f64 / 1000.0,
            csv_escape(&voice.transcript),
            csv_escape(&voice.tags.join(" / ")),
            if voice.starred { "是" } else { "" },
            csv_escape(&voice.note),
        ));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, format!("\u{feff}{csv}"))?;
    let bytes = fs::metadata(path)
        .map(|meta| meta.len() as i64)
        .unwrap_or(0);
    Ok(ExportReport {
        path: path.to_string_lossy().to_string(),
        files: 1,
        bytes,
    })
}

/// 导出单条语音到指定路径。
pub fn export_single(voice: &Voice, target: &Path) -> AppResult<ExportReport> {
    if voice.file_path.is_empty() || !Path::new(&voice.file_path).is_file() {
        return Err(AppError::msg("这条语音还没有音频文件"));
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::copy(&voice.file_path, target)?;
    let bytes = fs::metadata(target)
        .map(|meta| meta.len() as i64)
        .unwrap_or(0);
    Ok(ExportReport {
        path: target.to_string_lossy().to_string(),
        files: 1,
        bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_csv() {
        assert_eq!(csv_escape("a,b"), "\"a,b\"");
        assert_eq!(csv_escape("say \"hi\""), "\"say \"\"hi\"\"\"");
    }

    #[test]
    fn formats_duration() {
        assert_eq!(fmt_duration(65_000), "1:05");
        assert_eq!(fmt_duration(0), "0:00");
    }
}
