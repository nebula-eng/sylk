/**
 * 外部 NapCat 替身：起在固定端口，用来验证「连接已有 NapCat」模式。
 *
 *   node scripts/mock-napcat.mjs
 *   HTTP http://127.0.0.1:3000   WS ws://127.0.0.1:3001
 */

import { join } from "node:path";
import { AUDIO_FILES, ensureAudio, startOneBot } from "./lib/onebot-fixture.mjs";

const HTTP_PORT = Number(process.env.MOCK_HTTP_PORT || 3000);
const WS_PORT = Number(process.env.MOCK_WS_PORT || 3001);
const TOKEN = process.env.MOCK_TOKEN || "";
const AUDIO_DIR = join(process.cwd(), ".mock-napcat");

const log = (line) => console.log(`[mock] ${line}`);

await ensureAudio(AUDIO_DIR, log);
await startOneBot({
  httpPort: HTTP_PORT,
  wsPort: WS_PORT,
  token: TOKEN,
  audioDir: AUDIO_DIR,
  log,
  pushVoices: 3,
  pushInterval: 4000,
});

log(`HTTP  http://127.0.0.1:${HTTP_PORT}`);
log(`WS    ws://127.0.0.1:${WS_PORT}`);
log(`音频   ${AUDIO_DIR}（${AUDIO_FILES.length} 组 WAV + SILK）`);
