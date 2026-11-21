import { useCallback, useEffect, useRef } from "react";

import { useApp } from "@/lib/store";

interface WaveformProps {
  peaks: number[];
  /** 0 - 1，已播放比例 */
  progress?: number;
  height?: number;
  bars?: number;
  onSeek?: (ratio: number) => void;
  className?: string;
  dimmed?: boolean;
}

/** 用 canvas 画波形：几十条到上百条都不会拖慢列表。 */
export function Waveform({
  peaks,
  progress = 0,
  height = 26,
  bars = 40,
  onSeek,
  className,
  dimmed,
}: WaveformProps) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const theme = useApp((state) => state.theme);
  const hoverRef = useRef<number | null>(null);

  const draw = useCallback(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const parent = canvas.parentElement;
    if (!parent) return;
    const width = parent.clientWidth;
    if (width <= 0) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);

    const styles = getComputedStyle(document.documentElement);
    const accent = styles.getPropertyValue("--accent").trim() || "#3e63dd";
    const muted = styles.getPropertyValue("--border-strong").trim() || "#cfd5e1";

    const count = Math.max(8, bars);
    const step = width / count;
    const barWidth = Math.max(1.6, step * 0.56);
    const radius = Math.min(barWidth / 2, 1.6);
    const source = normalize(peaks, count);
    const hover = hoverRef.current;

    for (let index = 0; index < count; index += 1) {
      const value = source[index] / 100;
      const barHeight = Math.max(2, value * (height - 2));
      const x = index * step + (step - barWidth) / 2;
      const y = (height - barHeight) / 2;
      const played = index / count < progress;
      const isHover = hover !== null && index / count <= hover;
      context.fillStyle = played || isHover ? accent : muted;
      context.globalAlpha = played ? 1 : dimmed ? 0.5 : 0.85;
      context.beginPath();
      context.roundRect(x, y, barWidth, barHeight, radius);
      context.fill();
    }
    context.globalAlpha = 1;
  }, [peaks, progress, height, bars, dimmed, theme]);

  useEffect(() => {
    draw();
  }, [draw]);

  useEffect(() => {
    const canvas = ref.current;
    const parent = canvas?.parentElement;
    if (!parent) return;
    const observer = new ResizeObserver(() => draw());
    observer.observe(parent);
    return () => observer.disconnect();
  }, [draw]);

  const ratioFromEvent = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return 0;
    return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  };

  return (
    <div className={className ?? "player__wave"} style={{ position: "relative" }}>
      <canvas
        ref={ref}
        style={{ display: "block", cursor: onSeek ? "pointer" : "default" }}
        onPointerDown={
          onSeek
            ? (event) => {
                event.preventDefault();
                onSeek(ratioFromEvent(event));
              }
            : undefined
        }
        onPointerMove={
          onSeek
            ? (event) => {
                hoverRef.current = ratioFromEvent(event);
                draw();
              }
            : undefined
        }
        onPointerLeave={
          onSeek
            ? () => {
                hoverRef.current = null;
                draw();
              }
            : undefined
        }
      />
    </div>
  );
}

function normalize(peaks: number[], count: number): number[] {
  if (!peaks.length) {
    return Array.from({ length: count }, (_, index) => 18 + ((index * 37) % 42));
  }
  if (peaks.length === count) return peaks;
  const output: number[] = [];
  const ratio = peaks.length / count;
  for (let index = 0; index < count; index += 1) {
    const start = Math.floor(index * ratio);
    const end = Math.max(start + 1, Math.floor((index + 1) * ratio));
    let peak = 0;
    for (let cursor = start; cursor < end && cursor < peaks.length; cursor += 1) {
      peak = Math.max(peak, peaks[cursor] ?? 0);
    }
    output.push(peak);
  }
  return output;
}
