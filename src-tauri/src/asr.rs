use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;

use crate::error::{AppError, AppResult};
use crate::media;
use crate::models::{AsrProbe, AsrSettings};

/// 探测当前配置的转写引擎是否真的可用，避免用户点「转写」才看到一堆报错。
pub fn probe(settings: &AsrSettings) -> AsrProbe {
    if settings.engine == "openai" {
        let ready = !settings.api_base.trim().is_empty()
            && !settings.api_key.trim().is_empty()
            && !settings.api_model.trim().is_empty();
        return AsrProbe {
            engine: "openai".into(),
            available: ready,
            detail: if ready {
                format!("{} · {}", settings.api_base, settings.api_model)
            } else {
                "需要填写接口地址、密钥与模型名".into()
            },
        };
    }

    match locate_whisper(settings) {
        Some(exe) => {
            if settings.model_path.trim().is_empty() {
                AsrProbe {
                    engine: "whisper-cli".into(),
                    available: false,
                    detail: format!("已找到 {}，但还没有选择模型文件", exe.display()),
                }
            } else if !Path::new(&settings.model_path).is_file() {
                AsrProbe {
                    engine: "whisper-cli".into(),
                    available: false,
                    detail: format!("模型文件不存在：{}", settings.model_path),
                }
            } else {
                AsrProbe {
                    engine: "whisper-cli".into(),
                    available: true,
                    detail: format!("{} · {}", exe.display(), file_name(&settings.model_path)),
                }
            }
        }
        None => AsrProbe {
            engine: "whisper-cli".into(),
            available: false,
            detail: "未找到 whisper-cli，可在设置里指定可执行文件路径".into(),
        },
    }
}

fn file_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string())
}

pub fn locate_whisper(settings: &AsrSettings) -> Option<PathBuf> {
    let configured = settings.whisper_path.trim();
    if !configured.is_empty() {
        let path = PathBuf::from(configured);
        if path.is_file() {
            return Some(path);
        }
    }

    for name in ["whisper-cli", "whisper-cli.exe", "main.exe"] {
        if let Ok(path) = which::which(name) {
            return Some(path);
        }
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        candidates.push(PathBuf::from(&local).join("Programs/whisper.cpp/whisper-cli.exe"));
        candidates.push(PathBuf::from(&local).join("Sylk/tools/whisper-cli.exe"));
    }
    candidates.push(PathBuf::from("C:/whisper/whisper-cli.exe"));
    candidates.push(PathBuf::from(
        "C:/whisper.cpp/build/bin/Release/whisper-cli.exe",
    ));
    if let Ok(home) = std::env::var("USERPROFILE") {
        candidates.push(PathBuf::from(&home).join("whisper.cpp/build/bin/Release/whisper-cli.exe"));
    }

    candidates.into_iter().find(|path| path.is_file())
}

/// 把任意可读音频整理成 whisper 需要的 16 kHz 单声道 WAV。
pub fn prepare_wav16k(source: &Path, work_dir: &Path) -> AppResult<PathBuf> {
    if !source.is_file() {
        return Err(AppError::msg(format!(
            "音频文件不存在：{}",
            source.display()
        )));
    }
    std::fs::create_dir_all(work_dir)?;
    let target = work_dir.join("asr-input-16k.wav");

    match media::read_wav(source) {
        Ok(wav) => {
            if wav.info.sample_rate == 16_000 && wav.info.channels == 1 {
                return Ok(source.to_path_buf());
            }
            let mono = media::resample_linear(
                &wav.samples,
                wav.info.channels,
                wav.info.sample_rate,
                16_000,
            );
            media::write_wav_mono16(&target, &mono, 16_000)?;
            Ok(target)
        }
        Err(_) => {
            // 非 WAV：交给 ffmpeg 处理（如果装了）。
            let ffmpeg = which::which("ffmpeg").map_err(|_| {
                AppError::msg("这条语音不是 WAV 格式，需要 ffmpeg 才能转写。请安装 ffmpeg 或在设置中让 NapCat 输出 WAV。")
            })?;
            let output = std::process::Command::new(ffmpeg)
                .args(["-y", "-i"])
                .arg(source)
                .args(["-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le"])
                .arg(&target)
                .output()?;
            if !output.status.success() {
                return Err(AppError::msg(format!(
                    "ffmpeg 转换失败：{}",
                    String::from_utf8_lossy(&output.stderr)
                        .chars()
                        .take(300)
                        .collect::<String>()
                )));
            }
            Ok(target)
        }
    }
}

pub async fn transcribe(
    settings: &AsrSettings,
    library_dir: &Path,
    audio_path: &Path,
) -> AppResult<String> {
    if settings.engine == "openai" {
        crate::privacy::validate_remote_url(&settings.api_base, "云端转写接口地址")?;
        return transcribe_remote(settings, audio_path).await;
    }
    transcribe_local(settings, library_dir, audio_path).await
}

async fn transcribe_local(
    settings: &AsrSettings,
    library_dir: &Path,
    audio_path: &Path,
) -> AppResult<String> {
    let exe = locate_whisper(settings)
        .ok_or_else(|| AppError::msg("未找到 whisper-cli，请在设置中指定路径"))?;
    if settings.model_path.trim().is_empty() {
        return Err(AppError::msg("尚未选择 whisper 模型文件"));
    }
    if !Path::new(&settings.model_path).is_file() {
        return Err(AppError::msg(format!(
            "模型文件不存在：{}",
            settings.model_path
        )));
    }

    let work_dir = library_dir.join(".work").join("asr");
    let source = audio_path.to_path_buf();
    let work = work_dir.clone();
    let input = tokio::task::spawn_blocking(move || prepare_wav16k(&source, &work))
        .await
        .map_err(|err| AppError::msg(format!("准备音频失败：{err}")))??;

    std::fs::create_dir_all(&work_dir)?;
    let prefix = work_dir.join(format!("asr-{}", uuid::Uuid::new_v4()));
    let mut cmd = Command::new(&exe);
    cmd.arg("-m")
        .arg(&settings.model_path)
        .arg("-f")
        .arg(&input)
        .arg("-l")
        .arg(if settings.language.trim().is_empty() {
            "zh"
        } else {
            settings.language.trim()
        })
        .arg("-t")
        .arg(settings.threads.clamp(1, 32).to_string())
        .arg("-otxt")
        .arg("-of")
        .arg(&prefix)
        .arg("-np")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    {
        // tokio 的 Command 在 Windows 上自带 creation_flags，避免弹出黑色控制台。
        cmd.creation_flags(0x0800_0000);
    }

    let output = tokio::time::timeout(Duration::from_secs(600), cmd.output())
        .await
        .map_err(|_| AppError::msg("转写超时（超过 10 分钟）"))??;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let summary: String = stderr.chars().take(300).collect();
        return Err(AppError::msg(format!("whisper-cli 执行失败：{summary}")));
    }

    let txt_path = prefix.with_extension("txt");
    let text = std::fs::read_to_string(&txt_path).unwrap_or_default();
    let _ = std::fs::remove_file(&txt_path);
    let cleaned = clean_transcript(&text);
    if cleaned.is_empty() {
        return Err(AppError::msg("未识别出文字（可能是纯噪声或静音）"));
    }
    Ok(cleaned)
}

async fn transcribe_remote(settings: &AsrSettings, audio_path: &Path) -> AppResult<String> {
    if settings.api_key.trim().is_empty() {
        return Err(AppError::msg("尚未填写接口密钥"));
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()?;
    let bytes = tokio::fs::read(audio_path).await?;
    let file_name = audio_path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "audio.wav".into());
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(file_name)
        .mime_str("audio/wav")?;
    let form = reqwest::multipart::Form::new()
        .text("model", settings.api_model.clone())
        .text("language", settings.language.clone())
        .text("response_format", "json")
        .part("file", part);

    let base = settings.api_base.trim_end_matches('/');
    let response = client
        .post(format!("{base}/audio/transcriptions"))
        .bearer_auth(settings.api_key.trim())
        .multipart(form)
        .send()
        .await?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        let summary: String = body.chars().take(300).collect();
        return Err(AppError::msg(format!(
            "转写接口返回 {}：{summary}",
            status.as_u16()
        )));
    }

    let value: serde_json::Value = response.json().await?;
    let text = value
        .get("text")
        .and_then(|item| item.as_str())
        .unwrap_or("")
        .to_string();
    let cleaned = clean_transcript(&text);
    if cleaned.is_empty() {
        return Err(AppError::msg("转写接口没有返回文字"));
    }
    Ok(cleaned)
}

/// whisper 会输出 `[BLANK_AUDIO]`、`(音乐)` 这类占位符，清掉更像人话。
pub fn clean_transcript(raw: &str) -> String {
    let mut lines: Vec<String> = Vec::new();
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let lower = trimmed.to_lowercase();
        if lower == "[blank_audio]"
            || lower == "[silence]"
            || lower == "(silence)"
            || lower == "[music]"
            || lower == "(music)"
        {
            continue;
        }
        lines.push(trimmed.to_string());
    }
    lines.join(" ").trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_placeholders() {
        assert_eq!(clean_transcript("[BLANK_AUDIO]\n"), "");
        assert_eq!(clean_transcript("你好\n世界\n"), "你好 世界");
    }
}
