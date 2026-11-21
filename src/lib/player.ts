import { create } from "zustand";

interface PlayerState {
  voiceId: number | null;
  playing: boolean;
  rate: number;
  volume: number;
  current: number;
  duration: number;
  loop: boolean;
  seekRequest: number | null;
  play: (id: number) => void;
  toggle: (id?: number) => void;
  setPlaying: (playing: boolean) => void;
  stop: () => void;
  setRate: (rate: number) => void;
  setVolume: (volume: number) => void;
  setTime: (current: number, duration: number) => void;
  requestSeek: (ratio: number) => void;
  consumeSeek: () => number | null;
  setLoop: (loop: boolean) => void;
}

export const usePlayer = create<PlayerState>((set, get) => ({
  voiceId: null,
  playing: false,
  rate: 1,
  volume: 1,
  current: 0,
  duration: 0,
  loop: false,
  seekRequest: null,

  play: (id) => {
    if (get().voiceId === id) {
      set({ playing: true });
    } else {
      set({ voiceId: id, playing: true, current: 0, duration: 0 });
    }
  },

  toggle: (id) => {
    const state = get();
    if (id !== undefined && id !== state.voiceId) {
      set({ voiceId: id, playing: true, current: 0, duration: 0 });
      return;
    }
    if (!state.voiceId) return;
    set({ playing: !state.playing });
  },

  setPlaying: (playing) => set({ playing }),
  stop: () => set({ voiceId: null, playing: false, current: 0, duration: 0 }),
  setRate: (rate) => set({ rate }),
  setVolume: (volume) => set({ volume }),
  setTime: (current, duration) => set({ current, duration }),
  requestSeek: (ratio) => set({ seekRequest: Math.min(1, Math.max(0, ratio)) }),
  consumeSeek: () => {
    const value = get().seekRequest;
    if (value !== null) set({ seekRequest: null });
    return value;
  },
  setLoop: (loop) => set({ loop }),
}));
