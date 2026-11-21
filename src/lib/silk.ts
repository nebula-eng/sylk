import { decode as decodeSilk } from "silk-wasm";

/** 把 base64 还原成字节数组。 */
export function base64ToBytes(input: string): Uint8Array {
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** PCM s16le 单声道 → WAV 容器。 */
export function pcmToWav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  const dataLength = pcm.byteLength;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);
  const writeText = (offset: number, text: string) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };

  writeText(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, "data");
  view.setUint32(40, dataLength, true);
  new Uint8Array(buffer, 44).set(pcm);
  return new Uint8Array(buffer);
}

export interface DecodedAudio {
  wav: Uint8Array;
  durationMs: number;
  sampleRate: number;
}

/**
 * 用 silk-wasm 在本地把 QQ 语音解成 WAV，不依赖 ffmpeg，也不需要联网。
 * QQ 语音绝大多数是 24 kHz 采样的 SILK v3。
 */
export async function silkToWav(base64: string, sampleRate = 24_000): Promise<DecodedAudio> {
  const bytes = base64ToBytes(base64);
  const result = await decodeSilk(bytes, sampleRate);
  return {
    wav: pcmToWav(result.data, sampleRate),
    durationMs: Math.round(result.duration),
    sampleRate,
  };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}
