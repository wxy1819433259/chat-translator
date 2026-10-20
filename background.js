/**
 * WA 实时翻译 — 后台服务（Service Worker）
 * 所有网络请求都放在这里，避免页面的 CSP / CORS 干扰。
 */

const DEFAULTS = {
  enabled: true,
  target: 'zh-CN',
  provider: 'google',            // google | deepl | llm
  translateOutgoing: false,
  showLangTag: true,
  maxChars: 3000,
  useContext: true,              // 是否把同会话前几条消息作为语境一起送过去
  contextCount: 2,
  glossary: '',                  // 自定义术语表，每行 "原文=译文"
  llm: {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    systemPrompt: ''
  },
  deepl: { apiKey: '' }
};

const TARGET_NAME = {
  'zh-CN': '简体中文',
  'zh-TW': '繁体中文'
};

/**
 * 内置提示词：针对 WhatsApp 商务沟通做了强化。
 * 重点解决「缺标点导致状语修饰错位」这类机翻硬伤
 * （例：pt "desculpe a demora na segunda feira vejo isso" 被误连成"周一耽搁了"）。
 */
const BASE_PROMPT = [
  '你是资深外贸/跨境电商业务员的即时通讯翻译，把客户发来的消息翻成{lang}。',
  '',
  '输入是 WhatsApp 等聊天工具里的消息，经常缺少标点、有缩写俚语、拼写错误，或来自语音转文字。',
  '请先在内部完成断句和意群划分，确认每个状语/介词短语修饰的是哪个动词，再翻译。',
  '',
  '硬性要求：',
  '1. 忠实原意，不要漏译、不要自行补充。特别注意时间状语、否定词、条件句归属，缺标点时不要错误连读。',
  '   例：葡语「desculpe a demora, na segunda-feira vejo isso」中 na segunda-feira 修饰 vejo isso（周一我再看），',
  '   而不是修饰 desculpe a demora（周一耽搁了）。',
  '2. 译成自然的商务口语中文，像中国业务员读消息那样，避免翻译腔和书面套话。',
  '3. 表情符号、数字、金额、百分比、日期、人名、公司名、产品型号、链接、@提及一律原样保留。',
  '4. 客户的口头承诺、疑问、催促要还原语气强度，不要弱化也不要夸大。',
  '5. 若个别词确实无法判定，按最可能的商务场景译出，不要输出注释、括号说明或原文。',
  '6. 只输出译文本身。不要加引号、不要"译文："前缀、不要解释。'
].join('\n');

function mergeSettings(got) {
  const s = Object.assign({}, DEFAULTS, got || {});
  s.llm = Object.assign({}, DEFAULTS.llm, (got && got.llm) || {});
  s.deepl = Object.assign({}, DEFAULTS.deepl, (got && got.deepl) || {});
  return s;
}

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(null, (got) => resolve(mergeSettings(got || {})));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------- 分句 ---------------------------------- */

function splitChunks(text, size) {
  if (text.length <= size) return [text];
  const out = [];
  let rest = text;
  const marks = ['\n', '。', '！', '？', '. ', '! ', '? ', '；', '; ', '，', ', '];
  while (rest.length > size) {
    const windowText = rest.slice(0, size);
    let cut = -1;
    for (const m of marks) {
      const idx = windowText.lastIndexOf(m);
      if (idx > cut) cut = idx + m.length;
    }
    if (cut < size * 0.4) cut = size;           // 找不到合适断点就硬切
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) out.push(rest);
  return out;
}

/* ------------------------------ 语境 / 术语表 ------------------------------ */

/** 术语表：把 "pedido=订单" 这类行解析成 [{src,dst}] */
function parseGlossary(raw) {
  if (!raw || typeof raw !== 'string') return [];
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && line.indexOf('=') > 0)
    .map((line) => {
      const i = line.indexOf('=');
      return { src: line.slice(0, i).trim(), dst: line.slice(i + 1).trim() };
    })
    .filter((p) => p.src && p.dst)
    .slice(0, 300);
}

/** 只取真正有帮助的术语（本句里出现过的），避免提示词过长 */
function relevantGlossary(glossary, text) {
  if (!glossary.length) return [];
  const lower = text.toLowerCase();
  return glossary.filter((g) => lower.indexOf(g.src.toLowerCase()) > -1).slice(0, 40);
}

function buildContextBlock(context) {
  if (!Array.isArray(context) || !context.length) return '';
  const lines = [];
  for (const c of context.slice(-6)) {
    const t = String((c && c.text) || '').trim();
    if (!t) continue;
    const who = c && c.dir === 'out' ? '我' : '客户';
    lines.push(who + '：' + t.slice(0, 300));
  }
  if (!lines.length) return '';
  return (
    '【同一段对话里，前面已发的消息（仅帮助理解语境，不要翻译它们）】\n' +
    lines.join('\n') +
    '\n【以上仅为背景，现在只需翻译最后给出的那条新消息】'
  );
}

/* -------------------------------- 各翻译通道 -------------------------------- */

async function googleTranslate(text, target) {
  const chunks = splitChunks(text, 900);
  const pieces = [];
  let detected = '';
  for (const chunk of chunks) {
    const url =
      'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=auto&tl=' +
      encodeURIComponent(target) +
      '&q=' +
      encodeURIComponent(chunk);
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
        if (res.status === 429) {
          lastErr = new Error('请求过于频繁（429），请稍后再试');
          await sleep(700 * (attempt + 1));
          continue;
        }
        if (!res.ok) throw new Error('翻译服务返回 HTTP ' + res.status);
        const data = await res.json();
        const segs = Array.isArray(data && data[0]) ? data[0] : [];
        const out = segs.map((s) => (s && s[0]) || '').join('');
        if (!out.trim()) throw new Error('翻译结果为空');
        if (!detected && data && data[2]) detected = String(data[2]);
        pieces.push(out);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        await sleep(300);
      }
    }
    if (lastErr) throw lastErr;
  }
  return { text: pieces.join(''), lang: detected, provider: 'google' };
}

async function deeplTranslate(text, target, settings, opts) {
  const key = (settings.deepl.apiKey || '').trim();
  if (!key) throw new Error('还没有填写 DeepL API Key（在设置里填写）');
  const endpoint = key.endsWith(':fx')
    ? 'https://api-free.deepl.com/v2/translate'
    : 'https://api.deepl.com/v2/translate';
  const body = new URLSearchParams();
  body.append('text', text);
  body.append('target_lang', target === 'zh-TW' ? 'ZH-HANT' : 'ZH');

  // DeepL 的 context 能显著改善代词指代与句间衔接（不产生额外计费字符）
  const ctxBlock = buildContextBlock(opts && opts.context);
  if (ctxBlock) body.append('context', ctxBlock.slice(0, 2000));

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: 'DeepL-Auth-Key ' + key,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  });
  if (!res.ok) {
    const msg = res.status === 403 ? 'DeepL 鉴权失败，请检查 API Key' : 'DeepL 返回 HTTP ' + res.status;
    throw new Error(msg);
  }
  const data = await res.json();
  const item = (data.translations && data.translations[0]) || {};
  return {
    text: item.text || '',
    lang: String(item.detected_source_language || '').toLowerCase(),
    provider: 'deepl'
  };
}

async function llmTranslate(text, target, settings, opts) {
  const cfg = settings.llm || {};
  const base = (cfg.baseUrl || '').trim().replace(/\/+$/, '');
  const key = (cfg.apiKey || '').trim();
  if (!base) throw new Error('还没有填写大模型 Base URL（在设置里填写）');
  if (!key) throw new Error('还没有填写大模型 API Key（在设置里填写）');
  const langName = TARGET_NAME[target] || '简体中文';

  let system = (cfg.systemPrompt || '').trim();
  if (!system) system = BASE_PROMPT.replace('{lang}', langName);
  else if (system.indexOf('{lang}') > -1) system = system.replace(/\{lang\}/g, langName);

  // 术语表：只挑本句真正用到的词，避免提示词膨胀
  const gl = relevantGlossary(parseGlossary(settings.glossary), text);
  if (gl.length) {
    system +=
      '\n\n以下术语必须严格按给定译法处理（客户行业习惯用法，优先于通用译法）：\n' +
      gl.map((g) => g.src + ' = ' + g.dst).join('\n');
  }

  const ctxBlock = buildContextBlock(opts && opts.context);
  const userContent = ctxBlock ? ctxBlock + '\n\n【待翻译的新消息】\n' + text : text;

  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + key
    },
    body: JSON.stringify({
      model: cfg.model || 'deepseek-chat',
      temperature: 0.15,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userContent }
      ]
    })
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error('大模型接口返回 HTTP ' + res.status + (detail ? '：' + detail.slice(0, 120) : ''));
  }
  const data = await res.json();
  let out =
    data && data.choices && data.choices[0] && data.choices[0].message
      ? String(data.choices[0].message.content || '').trim()
      : '';
  // 个别模型爱加"译文："前缀或整段引号，统一剥掉
  out = out
    .replace(/^(译文|翻译|中文)[:：]\s*/, '')
    .replace(/^["“「]([\s\S]*)["”」]$/, '$1')
    .trim();
  if (!out) throw new Error('大模型返回内容为空');
  return { text: out, lang: '', provider: 'llm' };
}

/* --------------------------------- 入口 --------------------------------- */

async function doTranslate(payload) {
  const settings = await getSettings();
  const target = payload.target || settings.target || 'zh-CN';
  const provider = payload.provider || settings.provider || 'google';
  const text = String(payload.text || '').slice(0, 6000).trim();
  if (!text) throw new Error('没有可翻译的文本');

  // 只有用户开了"带上下文"才把前几条消息送过去；永远取最近 n 条
  let context = [];
  if (Array.isArray(payload.context) && settings.useContext !== false) {
    const n = Math.max(0, Number(settings.contextCount) || 0);
    context = n ? payload.context.slice(-n) : [];
  }
  const opts = { context };

  let result;
  if (provider === 'llm') result = await llmTranslate(text, target, settings, opts);
  else if (provider === 'deepl') result = await deeplTranslate(text, target, settings, opts);
  else {
    try {
      result = await googleTranslate(text, target);
    } catch (e) {
      // Google 不通（例如网络受限）时，如果配置了大模型 Key，自动兜底
      const hasLlm = settings.llm && settings.llm.apiKey;
      if (!hasLlm) throw e;
      result = await llmTranslate(text, target, settings, opts);
      result.provider = 'llm';
    }
  }

  if (!result.text || !result.text.trim()) throw new Error('翻译结果为空');
  return {
    ok: true,
    text: result.text.trim(),
    lang: (result.lang || '').split('-')[0],
    provider: result.provider
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'wat:translate') {
    doTranslate(msg)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true; // 异步响应
  }

  // 双击译文块「AI 精译」：强制走大模型，带上下文重译这条
  if (msg.type === 'wat:refine') {
    doTranslate({
      text: msg.text,
      target: msg.target,
      provider: 'llm',
      context: msg.context
    })
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }

  if (msg.type === 'wat:test') {
    doTranslate({
      text: msg.sample || 'Olá desculpe a demora na segunda feira vejo isso',
      target: msg.target || 'zh-CN',
      provider: msg.provider,
      context: msg.context || []
    })
      .then((r) => sendResponse(Object.assign({ sample: r.text }, r)))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
});

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.storage.sync.get(null, (got) => {
      const patch = {};
      Object.keys(DEFAULTS).forEach((k) => {
        if (got[k] === undefined) patch[k] = DEFAULTS[k];
      });
      if (Object.keys(patch).length) chrome.storage.sync.set(patch);
    });
  }
});
