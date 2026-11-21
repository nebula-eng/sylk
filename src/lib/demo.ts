import type {
  Conversation,
  DayCount,
  HeatCell,
  StatsBundle,
  Voice,
} from "./types";

/**
 * 演示数据：只在前端预览模式（非 Tauri 环境）或用户主动点击「载入演示」时使用。
 * 所有文本都是人写的口语，避免一眼假的模板腔。
 */

interface ConvSpec {
  title: string;
  kind: "group" | "friend";
  memberCount: number;
  peerId: string;
  senders: { id: string; name: string }[];
  lines: string[];
}

const CONV_SPECS: ConvSpec[] = [
  {
    title: "示例技术群",
    kind: "group",
    memberCount: 12,
    peerId: "10000003",
    senders: [
      { id: "1001", name: "示例发送者C" },
      { id: "1002", name: "示例发送者A" },
      { id: "1003", name: "木子" },
      { id: "1004", name: "K" },
    ],
    lines: [
      "日志我看了，报错在第三步之后，估计是路径没传进去，你先把环境变量贴一下。",
      "这台机器磁盘只剩 8 个 G 了，明天得清一下，不然打包肯定失败。",
      "我把 nginx 的配置改成反代 3001 了，你那边刷新一下应该就通了。",
      "刚压测了一轮，单机八百并发的时候 P99 到了 1.2 秒，主要是数据库那条慢查询。",
      "那个证书明天到期，别忘了续，上次就是因为这个挂了一晚上。",
      "接口我先按 v2 写了，字段名跟文档对齐，有冲突你直接改我这边。",
      "监控告警的阈值调低一点吧，现在这个配置基本发现不了问题。",
      "我把日志按天切了，超过三十天的自动删，先跑一周看看量。",
      "你那边能复现吗，我本地怎么试都是好的，一到线上就 502。",
      "回滚脚本我放 deploy 目录了，执行之前记得先备份数据库。",
      "现在这个版本的内存占用稳定在 180 兆，比上个版本降了快一半。",
      "晚上八点我发一版到测试环境，你们明天上班前帮忙点一下主要流程。",
    ],
  },
  {
    title: "示例比赛小分队",
    kind: "group",
    memberCount: 6,
    peerId: "10000004",
    senders: [
      { id: "2001", name: "组长·陈" },
      { id: "2002", name: "小林" },
      { id: "2003", name: "苏" },
      { id: "2004", name: "示例发送者A" },
    ],
    lines: [
      "答辩 PPT 我改到第三版了，明天中午之前大家再过一遍，重点是创新点那两页。",
      "评委很可能会问数据来源，我们把采集脚本和原始数据都放进附录，别到时候说不清。",
      "演示视频我录了一版，三分半，节奏还是有点赶，要不要砍掉部署那一段。",
      "作品说明书的格式按学校模板来，字体和行距都有要求，我发群里了。",
      "那个对比实验还要补一组，不然审稿人肯定说基线不够。",
      "我明天上午去实验室把设备调好，十点之前到就行。",
      "负责人说要交一份纸质版，周五下班前送到教务处，别忘了签字。",
      "预算还剩一千二，够做一个展板加两套备用件。",
      "演示的时候网络一定要用本地的，现场 wifi 不稳，上次就翻车了。",
      "我今晚把流程图重画一遍，之前那版箭头太乱了。",
    ],
  },
  {
    title: "示例发送者A",
    kind: "friend",
    memberCount: 0,
    peerId: "10000001",
    senders: [{ id: "10000001", name: "示例发送者A" }],
    lines: [
      "你下班了吗，楼下那家面馆今天排队排到门口了。",
      "我把那本书放你桌上了，第二本我看完了再还你。",
      "明天记得带伞，预报说有雨，别又淋成落汤鸡。",
      "刚看到一个特别好笑的视频，等会儿发你。",
      "你上次说的那个耳机我买了，降噪确实可以，就是有点夹头。",
      "周末去不去爬山，人不多的话我就订票了。",
      "我妈寄了一箱橘子过来，太多了，你拿点走。",
      "那个快递我帮你签收了，放门口鞋柜上了。",
      "晚上十点之后别喝咖啡了，你昨天不是说睡不着。",
      "我到楼下了，你慢慢来不着急。",
    ],
  },
  {
    title: "示例兴趣研究所",
    kind: "group",
    memberCount: 9,
    peerId: "10000005",
    senders: [
      { id: "3001", name: "老王" },
      { id: "3002", name: "橙子" },
      { id: "3003", name: "小满" },
      { id: "3004", name: "阿吉" },
    ],
    lines: [
      "冰箱里那盒酸奶谁喝的，过期两天了，别喝了啊。",
      "今晚谁做饭，我买了排骨和玉米，不会做的话我上手。",
      "空调滤网该洗了，出风一股灰味，我拆下来泡着了。",
      "楼下超市鸡蛋打折，三块八一斤，我囤了两板。",
      "有人要一起点奶茶吗，凑单免配送费。",
      "阳台那盆绿萝快死了，是不是浇水太勤了。",
      "我明天早班，晚上十一点就睡了，别在客厅放歌。",
      "垃圾我带下去了，明天轮到你。",
      "热水器又跳闸了，谁有空看一下，我不敢碰。",
      "周末大扫除吧，厨房油烟机真的该拆了洗。",
    ],
  },
  {
    title: "示例发送者B（维修）",
    kind: "friend",
    memberCount: 0,
    peerId: "10000002",
    senders: [{ id: "10000002", name: "示例发送者B" }],
    lines: [
      "你这个情况多半是电容坏了，换一个三十块钱，我下午过去。",
      "上门费五十，配件另算，修不好不要钱。",
      "我大概四点到，你在家就行，不用特意等。",
      "机器型号拍个照片发我，我先看看有没有现货。",
      "修好了，你试一下，要是还跳闸就再给我打电话。",
      "这个用了七八年了，能用就先用着，换新的不划算。",
    ],
  },
  {
    title: "Sylk 内测反馈",
    kind: "group",
    memberCount: 24,
    peerId: "10000006",
    senders: [
      { id: "4001", name: "阿茶" },
      { id: "4002", name: "南风" },
      { id: "4003", name: "十七" },
      { id: "4004", name: "木木" },
    ],
    lines: [
      "刚试了一下历史同步，一个五百人的群拉到两个月前，大概花了四分钟。",
      "转写准确率比我预期好，方言重的地方会乱，普通话基本没问题。",
      "建议加一个按人筛选，我想把一个同事说过的话全导出来。",
      "导出那个 html 挺好的，直接发给别人就能听，不用装软件。",
      "能不能支持快捷键，我现在都是用鼠标点，效率有点低。",
      "界面挺干净的，就是列表密度有点松，一屏看不了几条。",
      "我发现一个问题，语音超过一分钟的，波形加载会卡一下。",
      "暗色模式什么时候上，晚上用有点刺眼。",
      "标签批量加能不能做，我几百条一条条点太累了。",
      "那个收藏的星标建议换成实心，现在空心有点看不出来。",
      "存储占了多少能在设置里看到吗，我盘比较小。",
      "整体挺好用的，已经把我两个群的历史语音全存下来了。",
    ],
  },
];

const DAY = 86_400;

function createRandom(seed: number) {
  let state = seed % 2_147_483_647;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_647;
    return state / 2_147_483_647;
  };
}

function buildPeaks(random: () => number, durationMs: number): number[] {
  const count = 96;
  const base = Math.min(96, 24 + durationMs / 400);
  return Array.from({ length: count }, (_, index) => {
    const envelope = Math.sin((index / count) * Math.PI);
    const noise = 0.45 + random() * 0.55;
    return Math.max(4, Math.round(base * envelope * noise));
  });
}

let cache: { conversations: Conversation[]; voices: Voice[]; stats: StatsBundle } | null = null;

export function demoData() {
  if (cache) return cache;

  const random = createRandom(2026_1120);
  const now = Math.floor(Date.now() / 1000);
  const conversations: Conversation[] = [];
  const voices: Voice[] = [];
  let voiceId = 1;

  CONV_SPECS.forEach((spec, convIndex) => {
    const conversation: Conversation = {
      id: convIndex + 1,
      kind: spec.kind,
      peerId: spec.peerId,
      title: spec.title,
      avatar: "",
      memberCount: spec.memberCount,
      remark: "",
      voiceCount: 0,
      totalMs: 0,
      lastVoiceAt: null,
      starred: convIndex === 0,
      syncedAt: now - 3_600,
    };

    const count = spec.kind === "group" ? 9 + Math.floor(random() * 5) : 6 + Math.floor(random() * 4);
    const convVoices: Voice[] = [];

    for (let index = 0; index < count; index += 1) {
      const sender = spec.senders[Math.floor(random() * spec.senders.length)];
      const line = spec.lines[(index + convIndex * 3) % spec.lines.length];
      // 越靠后的会话整体时间越早，让列表有层次。
      const daysAgo = Math.floor(random() * 26) + convIndex;
      const hour = 8 + Math.floor(random() * 14);
      const minute = Math.floor(random() * 60);
      const second = Math.floor(random() * 60);
      const sentAt = now - daysAgo * DAY - (23 - hour) * 3600 - minute * 60 - second;
      const durationMs = Math.round(1_800 + random() * 26_000);

      const voice: Voice = {
        id: voiceId++,
        conversationId: conversation.id,
        conversationTitle: conversation.title,
        conversationKind: conversation.kind,
        msgId: `${spec.peerId}-${index}`,
        senderId: sender.id,
        senderName: sender.name,
        sentAt,
        durationMs,
        sizeBytes: Math.round(durationMs * 2.4 + random() * 900),
        codec: "wav",
        sampleRate: 16000,
        playable: false,
        filePath: "",
        rawPath: "",
        source: random() > 0.45 ? "live" : "history",
        transcript: line,
        transcriptStatus: random() > 0.18 ? "done" : "none",
        transcriptError: "",
        asrEngine: "whisper-cli",
        peaks: buildPeaks(random, durationMs),
        starred: random() > 0.88,
        note: "",
        tags: random() > 0.8 ? ["待整理"] : [],
      };
      convVoices.push(voice);
    }

    convVoices.sort((a, b) => b.sentAt - a.sentAt);
    conversation.voiceCount = convVoices.length;
    conversation.totalMs = convVoices.reduce((sum, item) => sum + item.durationMs, 0);
    conversation.lastVoiceAt = convVoices[0]?.sentAt ?? null;

    conversations.push(conversation);
    voices.push(...convVoices);
  });

  conversations.sort((a, b) => (b.lastVoiceAt ?? 0) - (a.lastVoiceAt ?? 0));
  voices.sort((a, b) => b.sentAt - a.sentAt);

  cache = { conversations, voices, stats: buildStats(conversations, voices) };
  return cache;
}

export function buildStats(conversations: Conversation[], voices: Voice[]): StatsBundle {
  const totalMs = voices.reduce((sum, voice) => sum + voice.durationMs, 0);
  const transcribed = voices.filter((voice) => voice.transcriptStatus === "done").length;
  const storageBytes = voices.reduce((sum, voice) => sum + voice.sizeBytes, 0);
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todayStart = Math.floor(startOfToday.getTime() / 1000);

  const heat = new Map<string, number>();
  const days = new Map<string, number>();
  for (const voice of voices) {
    const date = new Date(voice.sentAt * 1000);
    const weekday = (date.getDay() + 6) % 7;
    const key = `${weekday}-${date.getHours()}`;
    heat.set(key, (heat.get(key) ?? 0) + 1);

    const dayKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    days.set(dayKey, (days.get(dayKey) ?? 0) + 1);
  }

  const heatmap: HeatCell[] = [];
  for (const [key, count] of heat) {
    const [weekday, hour] = key.split("-").map(Number);
    heatmap.push({ weekday, hour, count });
  }

  const daily: DayCount[] = [];
  for (let offset = 29; offset >= 0; offset -= 1) {
    const date = new Date(Date.now() - offset * DAY * 1000);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    daily.push({ day: key, count: days.get(key) ?? 0 });
  }

  const bySender = new Map<string, { name: string; voices: number; totalMs: number }>();
  for (const voice of voices) {
    const current = bySender.get(voice.senderId) ?? { name: voice.senderName, voices: 0, totalMs: 0 };
    current.voices += 1;
    current.totalMs += voice.durationMs;
    bySender.set(voice.senderId, current);
  }

  return {
    overview: {
      voices: voices.length,
      totalMs,
      conversations: conversations.filter((conversation) => conversation.voiceCount > 0).length,
      transcribed,
      storageBytes,
      today: voices.filter((voice) => voice.sentAt >= todayStart).length,
      starred: voices.filter((voice) => voice.starred).length,
      pendingJobs: 6,
      failedJobs: 1,
    },
    topConversations: [...conversations]
      .sort((a, b) => b.totalMs - a.totalMs)
      .slice(0, 8)
      .map((conversation) => ({
        id: conversation.id,
        title: conversation.title,
        kind: conversation.kind,
        avatar: conversation.avatar,
        voices: conversation.voiceCount,
        totalMs: conversation.totalMs,
      })),
    topSenders: [...bySender.entries()]
      .map(([senderId, value]) => ({ senderId, ...value }))
      .sort((a, b) => b.totalMs - a.totalMs)
      .slice(0, 10),
    heatmap,
    daily,
  };
}
