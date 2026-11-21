use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

use crate::error::{AppError, AppResult};
use crate::models::Account;

/// OneBot 11 HTTP 客户端。只覆盖 Sylk 用到的动作，但错误信息足够定位问题。
#[derive(Clone)]
pub struct NapcatClient {
    http: reqwest::Client,
    base: String,
    token: String,
}

#[derive(Debug, serde::Deserialize)]
struct ApiResponse {
    status: Option<String>,
    retcode: Option<i64>,
    message: Option<String>,
    wording: Option<String>,
    data: Option<Value>,
}

impl NapcatClient {
    pub fn new(base: &str, token: &str, http: reqwest::Client) -> Self {
        Self {
            http,
            base: base.trim().trim_end_matches('/').to_string(),
            token: token.trim().to_string(),
        }
    }

    async fn call(&self, action: &str, body: Value) -> AppResult<Value> {
        if self.base.is_empty() {
            return Err(AppError::msg("尚未配置 NapCat 地址"));
        }
        let url = format!("{}/{}", self.base, action);
        let mut request = self.http.post(&url).json(&body);
        if !self.token.is_empty() {
            request = request.header("Authorization", format!("Bearer {}", self.token));
        }
        let response = request.send().await.map_err(|err| {
            AppError::msg(format!(
                "连接 NapCat 失败（{url}）：{err}。请确认 NapCat 已启动且 HTTP 服务端口正确。"
            ))
        })?;

        let status_code = response.status();
        let text = response.text().await?;
        if !status_code.is_success() {
            return Err(AppError::msg(format!(
                "NapCat 返回 HTTP {}：{}",
                status_code.as_u16(),
                trim_body(&text)
            )));
        }

        let parsed: ApiResponse = serde_json::from_str(&text).map_err(|_| {
            AppError::msg(format!(
                "NapCat 返回内容不是 OneBot 11 格式（{action}）：{}",
                trim_body(&text)
            ))
        })?;

        if parsed.status.as_deref() == Some("failed") || parsed.retcode.unwrap_or(0) != 0 {
            let reason = parsed
                .wording
                .or(parsed.message)
                .unwrap_or_else(|| format!("retcode {}", parsed.retcode.unwrap_or(-1)));
            return Err(AppError::msg(format!("NapCat 拒绝执行 {action}：{reason}")));
        }

        Ok(parsed.data.unwrap_or(Value::Null))
    }

    pub async fn login_info(&self) -> AppResult<Account> {
        let data = self.call("get_login_info", json!({})).await?;
        let uin = value_to_string(data.get("user_id"));
        if uin.is_empty() {
            return Err(AppError::msg("NapCat 未返回登录账号，可能尚未扫码登录"));
        }
        let nickname = data
            .get("nickname")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        Ok(Account {
            avatar: friend_avatar(&uin),
            uin,
            nickname,
            online: true,
        })
    }

    pub async fn is_online(&self) -> bool {
        match self.call("get_status", json!({})).await {
            Ok(data) => data.get("online").and_then(Value::as_bool).unwrap_or(true),
            Err(_) => false,
        }
    }

    pub async fn group_list(&self) -> AppResult<Vec<Value>> {
        let data = self.call("get_group_list", json!({})).await?;
        Ok(as_array(data))
    }

    pub async fn friend_list(&self) -> AppResult<Vec<Value>> {
        let data = self.call("get_friend_list", json!({})).await?;
        Ok(as_array(data))
    }

    pub async fn group_info(&self, group_id: &str) -> AppResult<Value> {
        self.call("get_group_info", json!({ "group_id": group_id }))
            .await
    }

    pub async fn stranger_info(&self, user_id: &str) -> AppResult<Value> {
        self.call("get_stranger_info", json!({ "user_id": user_id }))
            .await
    }

    pub async fn group_history(
        &self,
        group_id: &str,
        cursor: &str,
        count: u32,
    ) -> AppResult<Vec<Value>> {
        let mut body = json!({ "group_id": group_id, "count": count, "reverse_order": true });
        if !cursor.is_empty() {
            body["message_seq"] = Value::String(cursor.to_string());
        }
        let data = self.call("get_group_msg_history", body).await?;
        Ok(extract_messages(data))
    }

    pub async fn friend_history(
        &self,
        user_id: &str,
        cursor: &str,
        count: u32,
    ) -> AppResult<Vec<Value>> {
        let mut body = json!({ "user_id": user_id, "count": count, "reverse_order": true });
        if !cursor.is_empty() {
            body["message_seq"] = Value::String(cursor.to_string());
        }
        let data = self.call("get_friend_msg_history", body).await?;
        Ok(extract_messages(data))
    }

    /// 让 NapCat 把语音转成通用格式，返回它本机上的绝对路径。
    pub async fn record_path(&self, file: &str, format: &str) -> AppResult<String> {
        let data = self
            .call("get_record", json!({ "file": file, "out_format": format }))
            .await?;
        let path = data
            .get("file")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if path.is_empty() {
            return Err(AppError::msg("NapCat 没有返回语音文件路径"));
        }
        Ok(path)
    }
}

fn trim_body(text: &str) -> String {
    let cleaned = text.trim();
    if cleaned.is_empty() {
        return "<空响应>".into();
    }
    let mut out: String = cleaned.chars().take(240).collect();
    if cleaned.chars().count() > 240 {
        out.push('…');
    }
    out
}

pub fn value_to_string(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Number(number)) => number.to_string(),
        Some(Value::Bool(flag)) => flag.to_string(),
        _ => String::new(),
    }
}

fn as_array(data: Value) -> Vec<Value> {
    match data {
        Value::Array(items) => items,
        Value::Object(map) => {
            for key in ["list", "groups", "friends", "data"] {
                if let Some(Value::Array(items)) = map.get(key) {
                    return items.clone();
                }
            }
            Vec::new()
        }
        _ => Vec::new(),
    }
}

fn extract_messages(data: Value) -> Vec<Value> {
    match data {
        Value::Array(items) => items,
        Value::Object(map) => match map.get("messages") {
            Some(Value::Array(items)) => items.clone(),
            _ => Vec::new(),
        },
        _ => Vec::new(),
    }
}

pub fn group_avatar(group_id: &str) -> String {
    format!("https://p.qlogo.cn/gh/{group_id}/{group_id}/100")
}

pub fn friend_avatar(uin: &str) -> String {
    format!("https://q1.qlogo.cn/g?b=qq&nk={uin}&s=100")
}

// ---------------------------------------------------------------------------
// 消息段的宽容解析
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct RecordSegment {
    pub file: String,
    pub url: String,
    pub path: String,
    pub duration_ms: i64,
    pub magic: Option<i64>,
}

/// OneBot 的 message 可能是消息段数组，也可能是 CQ 码字符串。
/// 两种都要支持，否则换个 NapCat 配置就瞎了。
pub fn extract_records(message: &Value) -> Vec<RecordSegment> {
    match message {
        Value::Array(segments) => segments
            .iter()
            .filter_map(|seg| {
                let kind = seg.get("type").and_then(Value::as_str)?;
                if kind != "record" {
                    return None;
                }
                let data = seg.get("data")?;
                Some(record_from_data(data))
            })
            .collect(),
        Value::String(text) => parse_cq_records(text),
        _ => Vec::new(),
    }
}

fn record_from_data(data: &Value) -> RecordSegment {
    let duration_raw = data
        .get("duration")
        .and_then(Value::as_f64)
        .or_else(|| {
            data.get("duration")
                .and_then(Value::as_str)
                .and_then(|s| s.parse().ok())
        })
        .unwrap_or(0.0);
    // 有的实现给毫秒，有的给秒；取常见区间判断。
    let duration_ms = if duration_raw > 600.0 {
        duration_raw.round() as i64
    } else {
        (duration_raw * 1000.0).round() as i64
    };

    RecordSegment {
        file: str_field(data, "file"),
        url: str_field(data, "url"),
        path: str_field(data, "path"),
        duration_ms,
        magic: data.get("magic").and_then(Value::as_i64),
    }
}

fn str_field(data: &Value, key: &str) -> String {
    data.get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn parse_cq_records(text: &str) -> Vec<RecordSegment> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("[CQ:record,") {
        let after = &rest[start + "[CQ:record,".len()..];
        let Some(end) = after.find(']') else { break };
        let body = &after[..end];
        let mut seg = RecordSegment::default();
        for pair in body.split(',') {
            let Some((key, value)) = pair.split_once('=') else {
                continue;
            };
            let decoded = value
                .replace("&#44;", ",")
                .replace("&#91;", "[")
                .replace("&#93;", "]");
            match key {
                "file" => seg.file = decoded,
                "url" => seg.url = decoded,
                "path" => seg.path = decoded,
                "magic" => seg.magic = decoded.parse().ok(),
                _ => {}
            }
        }
        out.push(seg);
        rest = &after[end + 1..];
    }
    out
}

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct IncomingVoice {
    pub kind: String,
    pub peer_id: String,
    pub peer_name: String,
    pub msg_id: String,
    pub msg_seq: String,
    pub sender_id: String,
    pub sender_name: String,
    pub sent_at: i64,
    pub segment: RecordSegment,
}

#[derive(Debug, Clone)]
pub enum LiveEvent {
    /// 语音事件体积较大，装箱避免枚举整体被撑大。
    Voice(Box<IncomingVoice>),
    Connected,
}

/// 把一条 OneBot 事件翻译成 Sylk 关心的东西。
pub fn parse_event(event: &Value) -> Option<LiveEvent> {
    let post_type = event.get("post_type").and_then(Value::as_str).unwrap_or("");
    if post_type == "meta_event" {
        let meta = event
            .get("meta_event_type")
            .and_then(Value::as_str)
            .unwrap_or("");
        if meta == "lifecycle" {
            return Some(LiveEvent::Connected);
        }
        return None;
    }
    if post_type != "message" {
        return None;
    }

    let message_type = event
        .get("message_type")
        .and_then(Value::as_str)
        .unwrap_or("private");
    let (kind, peer_key, name_key) = if message_type == "group" {
        ("group", "group_id", "group_name")
    } else {
        ("friend", "user_id", "nickname")
    };

    let peer_id = value_to_string(event.get(peer_key));
    if peer_id.is_empty() {
        return None;
    }

    let message = event.get("message").cloned().unwrap_or(Value::Null);
    let records = extract_records(&message);
    let segment = records.into_iter().next()?;

    let sender = event.get("sender").cloned().unwrap_or(Value::Null);
    let sender_id = value_to_string(sender.get("user_id").or_else(|| event.get("user_id")));
    let sender_name = sender
        .get("card")
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
        .or_else(|| sender.get("nickname").and_then(Value::as_str))
        .unwrap_or("")
        .to_string();

    let peer_name = event
        .get(name_key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    let sent_at = event
        .get("time")
        .and_then(Value::as_i64)
        .filter(|ts| *ts > 1_000_000_000)
        .unwrap_or_else(|| chrono::Local::now().timestamp());

    let msg_id = {
        let raw = value_to_string(event.get("message_id"));
        if raw.is_empty() {
            value_to_string(event.get("real_id"))
        } else {
            raw
        }
    };
    if msg_id.is_empty() {
        return None;
    }

    let msg_seq = value_to_string(event.get("real_seq").or_else(|| event.get("message_seq")));

    Some(LiveEvent::Voice(Box::new(IncomingVoice {
        kind: kind.to_string(),
        peer_id,
        peer_name,
        msg_id,
        msg_seq,
        sender_id,
        sender_name,
        sent_at,
        segment,
    })))
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

pub fn ws_url_with_token(ws_url: &str, token: &str) -> String {
    let trimmed = ws_url.trim();
    if token.trim().is_empty() {
        return trimmed.to_string();
    }
    let separator = if trimmed.contains('?') { '&' } else { '?' };
    format!(
        "{trimmed}{separator}access_token={}",
        urlencoding::encode(token.trim())
    )
}

/// 建立一次连接并把事件推给回调。返回时表示连接已断开。
pub async fn pump_once<F>(url: &str, mut on_event: F) -> AppResult<()>
where
    F: FnMut(LiveEvent),
{
    let (mut socket, _) = tokio_tungstenite::connect_async(url)
        .await
        .map_err(|err| AppError::msg(format!("WebSocket 连接失败：{err}")))?;

    on_event(LiveEvent::Connected);

    loop {
        let next = tokio::time::timeout(Duration::from_secs(60), socket.next()).await;
        let message = match next {
            Err(_) => {
                // 心跳，顺便探活。
                socket
                    .send(Message::Ping(Vec::new()))
                    .await
                    .map_err(|err| AppError::msg(format!("WebSocket 心跳失败：{err}")))?;
                continue;
            }
            Ok(None) => break,
            Ok(Some(Err(err))) => {
                return Err(AppError::msg(format!("WebSocket 中断：{err}")));
            }
            Ok(Some(Ok(message))) => message,
        };

        match message {
            Message::Text(text) => {
                if let Ok(value) = serde_json::from_str::<Value>(&text) {
                    // API 调用响应带 echo/retcode，不是事件。
                    if value.get("echo").is_some() || value.get("retcode").is_some() {
                        continue;
                    }
                    if let Some(event) = parse_event(&value) {
                        on_event(event);
                    }
                }
            }
            Message::Binary(_) => {}
            Message::Ping(payload) => {
                let _ = socket.send(Message::Pong(payload)).await;
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_record_segment_array() {
        let message = json!([
            { "type": "text", "data": { "text": "听这个" } },
            { "type": "record", "data": { "file": "abc.silk", "url": "https://x/y", "duration": 4 } }
        ]);
        let records = extract_records(&message);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].file, "abc.silk");
        assert_eq!(records[0].duration_ms, 4000);
    }

    #[test]
    fn parses_cq_string() {
        let message = Value::String("[CQ:record,file=abc.amr,url=https://x/y]".into());
        let records = extract_records(&message);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].file, "abc.amr");
    }

    #[test]
    fn parses_group_voice_event() {
        let event = json!({
            "post_type": "message",
            "message_type": "group",
            "group_id": 123,
            "message_id": 456,
            "time": 1_700_000_000i64,
            "sender": { "user_id": 789, "nickname": "示例发送者A", "card": "岚" },
            "message": [{ "type": "record", "data": { "file": "v.silk", "url": "https://cdn/v" } }]
        });
        match parse_event(&event) {
            Some(LiveEvent::Voice(voice)) => {
                assert_eq!(voice.peer_id, "123");
                assert_eq!(voice.sender_name, "岚");
                assert_eq!(voice.msg_id, "456");
            }
            _ => panic!("应当解析成语音事件"),
        }
    }

    #[test]
    fn appends_token_to_ws_url() {
        assert_eq!(
            ws_url_with_token("ws://127.0.0.1:3001", "a b"),
            "ws://127.0.0.1:3001?access_token=a%20b"
        );
        assert_eq!(
            ws_url_with_token("ws://127.0.0.1:3001", ""),
            "ws://127.0.0.1:3001"
        );
    }
}
