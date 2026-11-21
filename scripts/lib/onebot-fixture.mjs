/**
 * 联调用的 OneBot 11 数据集与服务器。
 * 被 mock-napcat.mjs（外部模式）和 mock-engine.mjs（内嵌模式）共用。
 */

import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { encode as encodeSilk } from "silk-wasm";

/* ------------------------------------------------------------------ 音频 --- */

export const AUDIO_FILES = [
  { name: "voice-a.wav", seconds: 4.2, hz: 180 },
  { name: "voice-b.wav", seconds: 2.6, hz: 220 },
  { name: "voice-c.wav", seconds: 7.4, hz: 150 },
  { name: "voice-d.wav", seconds: 1.8, hz: 260 },
];

export function makeWav(seconds, baseHz) {
  const rate = 16_000;
  const frames = Math.floor(rate * seconds);
  const buffer = Buffer.alloc(44 + frames * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + frames * 2, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(frames * 2, 40);

  for (let i = 0; i < frames; i += 1) {
    const t = i / rate;
    const envelope = 0.35 + 0.65 * Math.abs(Math.sin(t * Math.PI * 1.7));
    const syllable =
      Math.sin(2 * Math.PI * baseHz * t) * 0.6 + Math.sin(2 * Math.PI * baseHz * 2.4 * t) * 0.3;
    const noise = (Math.random() - 0.5) * 0.06;
    const value = Math.max(-1, Math.min(1, syllable * envelope * 0.6 + noise));
    buffer.writeInt16LE(Math.round(value * 32_000), 44 + i * 2);
  }
  return buffer;
}

/** 生成 WAV 与配套的 SILK v3，两条下载路径都要有真货可验。 */
export async function ensureAudio(dir, log = () => {}) {
  mkdirSync(dir, { recursive: true });
  for (const file of AUDIO_FILES) {
    const wavPath = join(dir, file.name);
    if (!existsSync(wavPath)) writeFileSync(wavPath, makeWav(file.seconds, file.hz));

    const silkPath = join(dir, file.name.replace(/\.wav$/, ".silk"));
    if (!existsSync(silkPath)) {
      const pcm = makeWav(file.seconds, file.hz).subarray(44);
      const silk = await encodeSilk(pcm, 16_000);
      writeFileSync(silkPath, silk.data);
      log(`SILK ${file.name.replace(/\.wav$/, ".silk")} · ${silk.data.length} B`);
    }
  }
}

/* ----------------------------------------------------------------- 数据集 --- */

export const GROUPS = [
  { group_id: 10000003, group_name: "示例技术群", member_count: 12 },
  { group_id: 10000004, group_name: "示例比赛小分队", member_count: 6 },
];

export const FRIENDS = [
  { user_id: 10000001, nickname: "示例发送者A", remark: "示例发送者A" },
  { user_id: 10000002, nickname: "示例发送者B", remark: "示例发送者B（维修）" },
];

const SENDERS = [
  { user_id: 1001, nickname: "示例发送者C", card: "" },
  { user_id: 1002, nickname: "示例发送者A", card: "岚" },
  { user_id: 1003, nickname: "木子", card: "" },
];

export const SELF = { user_id: 10000001, nickname: "预览账号" };

/**
 * 一半语音带 WAV 直链，一半只有 SILK —— 逼 Sylk 把三条下载路径都走一遍。
 */
export function buildHistory(kind, peerId, httpPort, count = 24) {
  const now = Math.floor(Date.now() / 1000);
  const messages = [];
  for (let index = 0; index < count; index += 1) {
    const isVoice = index % 3 === 0;
    const file = AUDIO_FILES[index % AUDIO_FILES.length];
    // 语音的 index 都是 3 的倍数，直接取模只会命中同一个发送者；
    // 用 index/3 让语音也在几个人之间轮换。
    const sender = SENDERS[Math.floor(index / 3) % SENDERS.length];
    const base = {
      message_id: Number(`${peerId}${String(index).padStart(3, "0")}`),
      real_id: index + 1,
      message_seq: index + 1,
      // 24 条消息摊在 12 天里（每 12 小时一条）。以前是 15 分钟一条，
      // 全落在「今天」，日期筛选、按天分组、30 天趋势都测不出东西。
      time: now - (count - index) * 43_200,
      sender,
      message: [],
      raw_message: "",
    };

    if (isVoice) {
      const mode = index % 9 === 0 ? "wav-url" : index % 9 === 3 ? "silk-url" : "silk-file";
      const name =
        mode === "wav-url" ? file.name : file.name.replace(/\.wav$/, ".silk");
      base.message = [
        {
          type: "record",
          data: {
            file: name,
            url:
              mode === "wav-url"
                ? `http://127.0.0.1:${httpPort}/media/${file.name}`
                : mode === "silk-url"
                  ? `http://127.0.0.1:${httpPort}/media/${name}`
                  : "",
            duration: file.seconds,
            magic: 0,
          },
        },
      ];
      base.raw_message = `[CQ:record,file=${name}]`;
    } else {
      base.message = [{ type: "text", data: { text: `第 ${index + 1} 条文字消息` } }];
      base.raw_message = `第 ${index + 1} 条文字消息`;
    }
    messages.push(base);
  }
  // 按时间倒序返回，配合 Sylk「取最早一条做游标」的逻辑验证分页
  return messages.reverse();
}

export function makeLiveVoice(index, httpPort) {
  const file = AUDIO_FILES[index % AUDIO_FILES.length];
  const useSilk = index % 2 === 1;
  const name = useSilk ? file.name.replace(/\.wav$/, ".silk") : file.name;
  const senderIndex = index % SENDERS.length;
  const sender = SENDERS[senderIndex];
  const payload = {
    post_type: "message",
    message_type: index % 2 === 0 ? "group" : "private",
    sub_type: "normal",
    time: Math.floor(Date.now() / 1000),
    message_id: 900000 + index,
    real_id: 900000 + index,
    message_seq: 900000 + index,
    self_id: SELF.user_id,
    group_id: 10000003,
    group_name: "示例技术群",
    user_id: sender.user_id,
    nickname: sender.nickname,
    sender: { ...sender },
    message: [
      {
        type: "record",
        data: {
          file: name,
          url: useSilk ? "" : `http://127.0.0.1:${httpPort}/media/${name}`,
          duration: file.seconds,
          magic: 0,
        },
      },
    ],
    raw_message: `[CQ:record,file=${name}]`,
  };
  if (payload.message_type === "private") {
    delete payload.group_id;
    delete payload.group_name;
  }
  return payload;
}

/* ------------------------------------------------------------------ 服务 --- */

function reply(res, data) {
  const body = JSON.stringify({ status: "ok", retcode: 0, data });
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * @param {{ httpPort:number, wsPort:number, token?:string, audioDir:string,
 *           log?:(line:string)=>void, pushVoices?:number, pushInterval?:number }} options
 */
export function startOneBot(options) {
  const {
    httpPort,
    wsPort,
    token = "",
    audioDir,
    log = () => {},
    pushVoices = 0,
    pushInterval = 4000,
  } = options;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${httpPort}`);

    if (url.pathname.startsWith("/media/")) {
      const name = url.pathname.slice("/media/".length);
      const path = join(audioDir, name);
      if (!existsSync(path)) {
        res.writeHead(404).end("not found");
        return;
      }
      const buffer = readFileSync(path);
      res.writeHead(200, { "content-type": "audio/wav", "content-length": buffer.length });
      res.end(buffer);
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405).end("only POST");
      return;
    }
    if (token) {
      const header = req.headers.authorization || "";
      if (header !== `Bearer ${token}`) {
        res.writeHead(403, { "content-type": "application/json" }).end(
          JSON.stringify({ status: "failed", retcode: 1403, message: "token 不正确" }),
        );
        return;
      }
    }

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      body = {};
    }

    const action = url.pathname.replace(/^\//, "");
    log(`← ${action} ${JSON.stringify(body).slice(0, 90)}`);

    switch (action) {
      case "get_login_info":
        reply(res, SELF);
        return;
      case "get_status":
        reply(res, { online: true, good: true });
        return;
      case "get_group_list":
        reply(res, GROUPS);
        return;
      case "get_friend_list":
        reply(res, FRIENDS);
        return;
      case "get_group_info":
        reply(res, GROUPS.find((g) => String(g.group_id) === String(body.group_id)) ?? GROUPS[0]);
        return;
      case "get_stranger_info": {
        const friend = FRIENDS.find((f) => String(f.user_id) === String(body.user_id)) ?? FRIENDS[0];
        reply(res, { ...friend, sex: "unknown", age: 0 });
        return;
      }
      case "get_group_msg_history":
        reply(res, { messages: buildHistory("group", body.group_id, httpPort) });
        return;
      case "get_friend_msg_history":
        reply(res, { messages: buildHistory("friend", body.user_id, httpPort, 12) });
        return;
      case "get_record": {
        if (String(body.file).endsWith(".silk")) {
          // 模拟 NapCat 没装 ffmpeg：转码被拒，迫使 Sylk 走「保留原件 + 前端解码」
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({ status: "failed", retcode: 1400, message: "ffmpeg 未安装，无法转码" }),
          );
          return;
        }
        const file = AUDIO_FILES.find((item) => item.name === body.file);
        if (!file) {
          res.writeHead(200, { "content-type": "application/json" }).end(
            JSON.stringify({ status: "failed", retcode: 1404, message: "找不到这个语音文件" }),
          );
          return;
        }
        reply(res, { file: join(audioDir, file.name) });
        return;
      }
      case "get_version_info":
        reply(res, { app_name: "NapCat.Onebot", app_version: "4.18.19-mock" });
        return;
      default:
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({ status: "failed", retcode: 1404, message: `未实现的动作：${action}` }),
        );
    }
  });

  const wss = new WebSocketServer({ port: wsPort, host: "127.0.0.1" });

  wss.on("connection", (socket, request) => {
    const url = new URL(request.url, `ws://127.0.0.1:${wsPort}`);
    log(`WS 已连接${url.searchParams.get("access_token") ? "（带 token）" : ""}`);
    socket.send(
      JSON.stringify({
        post_type: "meta_event",
        meta_event_type: "lifecycle",
        sub_type: "connect",
        time: Math.floor(Date.now() / 1000),
        self_id: SELF.user_id,
      }),
    );

    let index = 0;
    const timer = setInterval(() => {
      if (index >= pushVoices) {
        clearInterval(timer);
        return;
      }
      const payload = makeLiveVoice(index, httpPort);
      const text = JSON.stringify(payload);
      for (const client of wss.clients) {
        if (client.readyState === 1) client.send(text);
      }
      log(`推送实时语音 #${index + 1}`);
      index += 1;
    }, pushInterval);
    socket.on("close", () => clearInterval(timer));
  });

  return new Promise((resolve) => {
    server.listen(httpPort, "127.0.0.1", () => {
      log(`HTTP 就绪 http://127.0.0.1:${httpPort}`);
      resolve({
        close: () => {
          wss.close();
          server.close();
        },
      });
    });
  });
}
