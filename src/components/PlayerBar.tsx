import { useEffect, useRef } from "react";
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Repeat,
  Volume2,
  VolumeX,
  Mic,
} from "lucide-react";

import { api } from "@/lib/api";
import { formatClock } from "@/lib/format";
import { usePlayer } from "@/lib/player";
import { useApp } from "@/lib/store";
import { Avatar, IconButton } from "@/components/ui/primitives";
import { Waveform } from "@/components/Waveform";

export function PlayerBar() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const voices = useApp((state) => state.voices);
  const toast = useApp((state) => state.toast);

  const voiceId = usePlayer((state) => state.voiceId);
  const playing = usePlayer((state) => state.playing);
  const rate = usePlayer((state) => state.rate);
  const volume = usePlayer((state) => state.volume);
  const current = usePlayer((state) => state.current);
  const duration = usePlayer((state) => state.duration);
  const loop = usePlayer((state) => state.loop);
  const seekRequest = usePlayer((state) => state.seekRequest);
  const setPlaying = usePlayer((state) => state.setPlaying);
  const setTime = usePlayer((state) => state.setTime);
  const setRate = usePlayer((state) => state.setRate);
  const setVolume = usePlayer((state) => state.setVolume);
  const setLoop = usePlayer((state) => state.setLoop);
  const requestSeek = usePlayer((state) => state.requestSeek);
  const consumeSeek = usePlayer((state) => state.consumeSeek);

  const voice = voices.find((item) => item.id === voiceId) ?? null;
  const index = voice ? voices.findIndex((item) => item.id === voice.id) : -1;

  // 换曲时通过后端命令读取音频字节，生成 blob URL 播放。
  // 不用 Tauri 的 asset 协议：那等于把本机文件读取能力暴露给 WebView，
  // 而这个能力只需要对「媒体库里的 WAV」开放。
  useEffect(() => {
    const audio = audioRef.current;
    let cancelled = false;
    const release = () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
    if (!audio || !voice?.id || !voice?.playable) {
      if (audio) {
        audio.pause();
        audio.removeAttribute("src");
        audio.load();
      }
      release();
      return;
    }
    void (async () => {
      try {
        const raw = await api.readVoiceAudio(voice.id);
        if (cancelled) return;
        const binary = atob(raw.data);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) {
          bytes[index] = binary.charCodeAt(index);
        }
        const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
        release();
        objectUrlRef.current = url;
        audio.src = url;
        audio.load();
      } catch (error) {
        if (cancelled) return;
        setPlaying(false);
        toast("error", error instanceof Error ? error.message : "无法读取音频文件");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [voice?.id, voice?.playable, setPlaying, toast]);

  useEffect(
    () => () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    },
    [],
  );

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      void audio.play().catch(() => {
        setPlaying(false);
        toast("error", "无法播放，文件可能已被移动或删除");
      });
    } else {
      audio.pause();
    }
  }, [playing, voice?.id, setPlaying, toast]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = rate;
  }, [rate, voice?.id]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.loop = loop;
  }, [loop, voice?.id]);

  useEffect(() => {
    if (seekRequest === null) return;
    const audio = audioRef.current;
    if (audio && Number.isFinite(audio.duration) && audio.duration > 0) {
      audio.currentTime = seekRequest * audio.duration;
    }
    consumeSeek();
  }, [seekRequest, consumeSeek]);

  const step = (offset: number) => {
    if (index < 0) return;
    const target = voices[index + offset];
    if (target) {
      usePlayer.getState().play(target.id);
    } else if (offset > 0) {
      setPlaying(false);
    }
  };

  const progress = duration > 0 ? Math.min(1, current / duration) : 0;
  const rateOptions = [0.75, 1, 1.25, 1.5, 2];
  const nextRate = () => {
    const currentIndex = rateOptions.indexOf(rate);
    const next = rateOptions[(currentIndex + 1) % rateOptions.length] ?? 1;
    setRate(next);
  };

  return (
    <footer className="player" aria-label="播放器">
      <audio
        ref={audioRef}
        preload="metadata"
        onTimeUpdate={(event) => {
          const audio = event.currentTarget;
          setTime(audio.currentTime, Number.isFinite(audio.duration) ? audio.duration : 0);
        }}
        onLoadedMetadata={(event) => {
          const audio = event.currentTarget;
          setTime(audio.currentTime, Number.isFinite(audio.duration) ? audio.duration : 0);
        }}
        onEnded={() => {
          if (loop) return;
          step(1);
        }}
      />

      {voice ? (
        <>
          <div className="player__info">
            <Avatar name={voice.senderName || "?"} size="sm" />
            <div className="player__titles">
              <div className="player__title">{voice.senderName || "未知发送者"}</div>
              <div className="player__sub">
                {voice.conversationTitle} · {index + 1}/{voices.length}
              </div>
            </div>
          </div>

          <div className="player__center">
            <IconButton label="上一条" disabled={index <= 0} onClick={() => step(-1)}>
              <SkipBack size={15} />
            </IconButton>
            <button
              type="button"
              className="play-btn play-btn--primary"
              onClick={() => setPlaying(!playing)}
              aria-label={playing ? "暂停" : "播放"}
            >
              {playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
            </button>
            <IconButton
              label="下一条"
              disabled={index < 0 || index >= voices.length - 1}
              onClick={() => step(1)}
            >
              <SkipForward size={15} />
            </IconButton>

            <span className="player__time tabular">{formatClock(current * 1000)}</span>
            <Waveform
              peaks={voice.peaks}
              bars={110}
              height={28}
              progress={progress}
              onSeek={(ratio) => requestSeek(ratio)}
              className="player__wave"
            />
            <span className="player__time tabular">{formatClock(voice.durationMs)}</span>
          </div>

          <div className="player__right">
            <button type="button" className="chip" onClick={nextRate} title="播放速度">
              {rate.toFixed(rate === 1 ? 0 : 2).replace(/0$/, "")}×
            </button>
            <IconButton
              label={loop ? "关闭单曲循环" : "单曲循环"}
              active={loop}
              onClick={() => setLoop(!loop)}
            >
              <Repeat size={15} />
            </IconButton>
            <IconButton
              label={volume === 0 ? "取消静音" : "静音"}
              onClick={() => setVolume(volume === 0 ? 1 : 0)}
            >
              {volume === 0 ? <VolumeX size={15} /> : <Volume2 size={15} />}
            </IconButton>
          </div>
        </>
      ) : (
        <div className="player__idle">
          <Mic size={15} />
          <span>选择一条语音开始播放</span>
          <span className="shortcut-hint" style={{ marginLeft: 10 }}>
            <span className="kbd">空格</span> 暂停
            <span className="kbd" style={{ marginLeft: 6 }}>
              ← →
            </span>
            换上下条
          </span>
          <span className="badge" style={{ marginLeft: "auto" }}>
            当前列表 {voices.length} 条
          </span>
        </div>
      )}
    </footer>
  );
}
