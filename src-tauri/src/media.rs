use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};

/// 音频库的目录布局：
///   <library>/audio/2026/11/20261120_143012_岚.wav
///   <library>/raw/2026/11/20261120_143012_岚.silk
///   <library>/exports/<会话名>/...
pub fn audio_dir(library: &Path, sent_at: i64) -> PathBuf {
    let (year, month) = year_month(sent_at);
    library.join("audio").join(year).join(month)
}

pub fn raw_dir(library: &Path, sent_at: i64) -> PathBuf {
    let (year, month) = year_month(sent_at);
    library.join("raw").join(year).join(month)
}

fn year_month(sent_at: i64) -> (String, String) {
    use chrono::{Local, TimeZone};
    let dt = Local
        .timestamp_opt(sent_at, 0)
        .single()
        .unwrap_or_else(Local::now);
    (dt.format("%Y").to_string(), dt.format("%m").to_string())
}

/// 文件名模板占位符：{date} {time} {sender} {duration} {seq}
pub fn render_filename(
    template: &str,
    sender: &str,
    sent_at: i64,
    duration_ms: i64,
    seq: &str,
) -> String {
    use chrono::{Local, TimeZone};
    let dt = Local
        .timestamp_opt(sent_at, 0)
        .single()
        .unwrap_or_else(Local::now);

    let safe_sender = sanitize_component(if sender.is_empty() { "未知" } else { sender });
    let mut name = template.to_string();
    for (key, value) in [
        ("{date}", dt.format("%Y%m%d").to_string()),
        ("{time}", dt.format("%H%M%S").to_string()),
        ("{sender}", safe_sender),
        ("{duration}", format!("{:.1}s", duration_ms as f64 / 1000.0)),
        ("{seq}", sanitize_component(seq)),
    ] {
        name = name.replace(key, &value);
    }
    let name = sanitize_component(&name);
    if name.trim().is_empty() {
        dt.format("%Y%m%d_%H%M%S").to_string()
    } else {
        name
    }
}

/// 清掉 Windows 不允许的字符，并限制长度。
pub fn sanitize_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => out.push('_'),
            c if (c as u32) < 0x20 => {}
            c => out.push(c),
        }
    }
    let trimmed: String = out.trim().trim_matches('.').chars().take(80).collect();
    trimmed.trim().to_string()
}

/// 同名文件不覆盖，追加 -2、-3。
pub fn unique_path(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let mut candidate = dir.join(format!("{stem}.{ext}"));
    let mut index = 2;
    while candidate.exists() {
        candidate = dir.join(format!("{stem}-{index}.{ext}"));
        index += 1;
        if index > 999 {
            break;
        }
    }
    candidate
}

/// 给进度提示用的人读体积。
pub fn human_size(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut index = 0;
    while value >= 1024.0 && index < UNITS.len() - 1 {
        value /= 1024.0;
        index += 1;
    }
    if index == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[index])
    }
}

pub fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

pub fn is_wav(bytes: &[u8]) -> bool {
    bytes.len() > 44 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WAVE"
}

pub fn is_silk(bytes: &[u8]) -> bool {
    // Tencent 的 SILK 一般是 "#!SILK_V3" 或旧版本以 0x02 开头。
    bytes.starts_with(b"#!SILK")
        || bytes.starts_with(b"#!SILK_V3")
        || (bytes.len() > 10 && bytes[0] == 0x02)
}

// ---------------------------------------------------------------------------
// WAV
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
#[allow(dead_code)]
pub struct WavInfo {
    pub sample_rate: u32,
    pub channels: u16,
    pub bits_per_sample: u16,
    pub duration_ms: i64,
}

pub struct Wav {
    pub info: WavInfo,
    pub samples: Vec<i16>,
}

/// 只解析 Sylk 需要的部分：fmt + data，且统一转成 i16 单声道视角。
pub fn read_wav(path: &Path) -> AppResult<Wav> {
    let bytes = fs::read(path)?;
    parse_wav(&bytes)
}

pub fn parse_wav(bytes: &[u8]) -> AppResult<Wav> {
    if !is_wav(bytes) {
        return Err(AppError::msg("不是有效的 WAV 文件"));
    }

    let mut cursor = 12usize;
    let mut sample_rate = 0u32;
    let mut channels = 0u16;
    let mut bits = 0u16;
    let mut data: Option<&[u8]> = None;

    while cursor + 8 <= bytes.len() {
        let id = &bytes[cursor..cursor + 4];
        let size = u32::from_le_bytes([
            bytes[cursor + 4],
            bytes[cursor + 5],
            bytes[cursor + 6],
            bytes[cursor + 7],
        ]) as usize;
        let body_start = cursor + 8;
        let body_end = body_start.saturating_add(size).min(bytes.len());
        let body = &bytes[body_start..body_end];

        match id {
            b"fmt " => {
                if body.len() >= 16 {
                    let format = u16::from_le_bytes([body[0], body[1]]);
                    channels = u16::from_le_bytes([body[2], body[3]]);
                    sample_rate = u32::from_le_bytes([body[4], body[5], body[6], body[7]]);
                    bits = u16::from_le_bytes([body[14], body[15]]);
                    if format != 1 && format != 0xFFFE {
                        return Err(AppError::msg("暂不支持非 PCM 编码的 WAV"));
                    }
                }
            }
            b"data" => {
                data = Some(body);
                break;
            }
            _ => {}
        }

        // chunk 按偶数字节对齐
        cursor = body_start + size + (size % 2);
    }

    let data = data.ok_or_else(|| AppError::msg("WAV 缺少 data 段"))?;
    if channels == 0 || sample_rate == 0 {
        return Err(AppError::msg("WAV 头信息不完整"));
    }

    let mut samples: Vec<i16> = Vec::new();
    match bits {
        16 => {
            samples.reserve(data.len() / 2);
            for pair in data.chunks_exact(2) {
                samples.push(i16::from_le_bytes([pair[0], pair[1]]));
            }
        }
        8 => {
            samples.reserve(data.len());
            for byte in data {
                samples.push(((*byte as i16) - 128) << 8);
            }
        }
        24 => {
            samples.reserve(data.len() / 3);
            for frame in data.chunks_exact(3) {
                let value =
                    ((frame[2] as i32) << 24 | (frame[1] as i32) << 16 | (frame[0] as i32) << 8)
                        >> 16;
                samples.push(value.clamp(i16::MIN as i32, i16::MAX as i32) as i16);
            }
        }
        32 => {
            samples.reserve(data.len() / 4);
            for frame in data.chunks_exact(4) {
                let value = i32::from_le_bytes([frame[0], frame[1], frame[2], frame[3]]);
                samples.push((value >> 16).clamp(i16::MIN as i32, i16::MAX as i32) as i16);
            }
        }
        other => {
            return Err(AppError::msg(format!("暂不支持 {other} 位深的 WAV")));
        }
    }

    let frames = if channels > 0 {
        samples.len() / channels as usize
    } else {
        0
    };
    let duration_ms = if sample_rate > 0 {
        (frames as f64 / sample_rate as f64 * 1000.0).round() as i64
    } else {
        0
    };

    Ok(Wav {
        info: WavInfo {
            sample_rate,
            channels,
            bits_per_sample: bits,
            duration_ms,
        },
        samples,
    })
}

pub fn write_wav_mono16(path: &Path, samples: &[i16], sample_rate: u32) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let data_len = samples.len() * 2;
    let mut out = Vec::with_capacity(44 + data_len);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&((36 + data_len) as u32).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&(sample_rate * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&(data_len as u32).to_le_bytes());
    for sample in samples {
        out.extend_from_slice(&sample.to_le_bytes());
    }
    let mut file = fs::File::create(path)?;
    file.write_all(&out)?;
    Ok(())
}

/// 简单线性插值重采样；语音转写场景够用，且不依赖 ffmpeg。
pub fn resample_linear(samples: &[i16], channels: u16, from_hz: u32, to_hz: u32) -> Vec<i16> {
    let channels = channels.max(1) as usize;
    let frames: Vec<i16> = if channels == 1 {
        samples.to_vec()
    } else {
        samples
            .chunks_exact(channels)
            .map(|frame| {
                let sum: i32 = frame.iter().map(|value| *value as i32).sum();
                (sum / channels as i32).clamp(i16::MIN as i32, i16::MAX as i32) as i16
            })
            .collect()
    };

    if from_hz == to_hz || frames.is_empty() {
        return frames;
    }

    let ratio = to_hz as f64 / from_hz as f64;
    let out_len = ((frames.len() as f64) * ratio).round().max(1.0) as usize;
    let mut out = Vec::with_capacity(out_len);
    for index in 0..out_len {
        let position = index as f64 / ratio;
        let left = position.floor() as usize;
        let frac = position - left as f64;
        let a = frames[left.min(frames.len() - 1)] as f64;
        let b = frames[(left + 1).min(frames.len() - 1)] as f64;
        out.push(
            (a + (b - a) * frac)
                .round()
                .clamp(i16::MIN as f64, i16::MAX as f64) as i16,
        );
    }
    out
}

/// 生成 0-100 的波形峰值，供列表和详情页绘制。
pub fn peaks_from_wav(wav: &Wav, buckets: usize) -> Vec<u8> {
    let buckets = buckets.clamp(8, 256);
    let channels = wav.info.channels.max(1) as usize;
    let frames = wav.samples.len() / channels;
    if frames == 0 {
        return vec![2; buckets];
    }
    let per_bucket = (frames as f64 / buckets as f64).max(1.0);
    let mut peaks = Vec::with_capacity(buckets);
    for index in 0..buckets {
        let start = (index as f64 * per_bucket) as usize;
        let end = (((index + 1) as f64 * per_bucket) as usize).min(frames);
        let mut peak = 0i32;
        for frame in start..end {
            let sample = wav.samples[frame * channels] as i32;
            peak = peak.max(sample.abs());
        }
        let scaled = ((peak as f32 / 32768.0) * 100.0).round().clamp(2.0, 100.0) as u8;
        peaks.push(scaled);
    }
    peaks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_illegal_chars() {
        assert_eq!(sanitize_component("a/b:c*d?"), "a_b_c_d_");
        assert_eq!(sanitize_component("  示例发送者A  "), "示例发送者A");
    }

    #[test]
    fn renders_template() {
        let name = render_filename(
            "{date}_{time}_{sender}",
            "示例发送者A",
            1_700_000_000,
            3200,
            "7",
        );
        assert!(name.starts_with("2023"));
        assert!(name.contains("示例发送者A"));
    }

    #[test]
    fn round_trips_wav() {
        let samples: Vec<i16> = (0..1600)
            .map(|i| ((i as f32 * 0.1).sin() * 8000.0) as i16)
            .collect();
        let dir = std::env::temp_dir().join("sylk-wav-test");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.wav");
        write_wav_mono16(&path, &samples, 16_000).unwrap();
        let wav = read_wav(&path).unwrap();
        assert_eq!(wav.info.sample_rate, 16_000);
        assert_eq!(wav.info.channels, 1);
        assert_eq!(wav.samples.len(), samples.len());
        assert!(wav.info.duration_ms >= 99 && wav.info.duration_ms <= 101);
        let peaks = peaks_from_wav(&wav, 32);
        assert_eq!(peaks.len(), 32);
        assert!(peaks.iter().any(|p| *p > 20));
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn resamples_down() {
        let input: Vec<i16> = (0..2400).map(|i| i as i16).collect();
        let out = resample_linear(&input, 1, 24_000, 16_000);
        assert_eq!(out.len(), 1600);
    }
}
