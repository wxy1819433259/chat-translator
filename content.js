/**
 * WA 实时翻译 — 内容脚本
 * 在 WhatsApp Web 每条消息气泡内、原文下方插入中文译文。
 */
(() => {
  'use strict';
  if (window.__WAT_LOADED__) return;
  window.__WAT_LOADED__ = true;

  /* ------------------------------- 配置默认值 ------------------------------- */
  const DEFAULTS = {
    enabled: true,
    target: 'zh-CN',
    provider: 'google',
    translateOutgoing: false,
    showLangTag: true,
    maxChars: 3000,
    useContext: true,
    contextCount: 2
  };

  const LANG_LABEL = {
    en: '英语', es: '西语', pt: '葡语', ar: '阿语', fr: '法语', de: '德语',
    ru: '俄语', ja: '日语', ko: '韩语', it: '意语', tr: '土语', hi: '印地语',
    id: '印尼语', th: '泰语', vi: '越南语', nl: '荷语', pl: '波语',
    fa: '波斯语', ur: '乌尔都语', he: '希伯来语', ms: '马来语', tl: '菲语',
    sv: '瑞典语', no: '挪威语', da: '丹麦语', fi: '芬兰语', cs: '捷克语',
    ro: '罗语', hu: '匈语', el: '希腊语', uk: '乌语', bn: '孟加拉语'
  };

  const MAX_CONCURRENCY = 2;
  const CACHE_LIMIT = 4000;

  let S = Object.assign({}, DEFAULTS);
  const states = new Map();   // bid -> { h, status: pending|done|error, text, lang, err }
  const memCache = new Map(); // cacheKey -> { text, lang }
  const writeBuffer = {};
  const queue = [];
  let active = 0;
  let statCount = 0;

  // 诊断计数：出问题时能一眼看出是「没找到消息」还是「取不到正文」还是「接口失败」
  const diag = { rows: 0, withText: 0, skipped: 0, requested: 0, failed: 0, lastError: '', sources: {} };

  /* --------------------------------- 工具 --------------------------------- */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  const cacheKey = (target, text) => target + '\u0001' + text;

  function normalize(raw) {
    let t = String(raw || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    const limit = Math.max(200, Number(S.maxChars) || 3000);
    if (t.length > limit) t = t.slice(0, limit) + ' …';
    return t;
  }

  function shouldTranslate(t) {
    if (!t) return false;
    if (!/\p{L}/u.test(t)) return false;                       // 纯表情/数字
    if (/^https?:\/\/\S+$/i.test(t)) return false;             // 纯链接
    const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
    const latin = (t.match(/[A-Za-z\u00c0-\u024f]/g) || []).length;
    if (cjk > 0 && cjk >= latin && cjk / t.length > 0.25) return false; // 已经是中文
    return true;
  }

  /* -------------------------------- DOM 解析 --------------------------------
   * WhatsApp 会不定期改类名（_akbu 这类是构建哈希），所以这里按「稳定特征优先、
   * 类名兜底」的四级策略找人：
   *   A. [data-pre-plain-text] —— 正文容器，长期稳定
   *   B. span.selectable-text —— 老版正文
   *   C. .copyable-text        —— 次老版正文容器
   *   D. 最内层 [dir] 文本块   —— 兜底，任何改版都还能捞到文字
   * ------------------------------------------------------------------------ */
  const PANEL_SELECTORS = [
    '#main',
    '[data-testid="conversation-panel-messages"]',
    '[data-testid="conversation-panel"]'
  ];

  function getPanel() {
    for (const s of PANEL_SELECTORS) {
      const el = document.querySelector(s);
      if (el) return el;
    }
    // 最后兜底：页面上确实存在消息行就退到 body（避免整块失灵）
    if (document.querySelector('[data-id^="false_"], [data-id^="true_"]')) return document.body;
    return null;
  }

  function collectMessageEls() {
    const panel = getPanel();
    if (!panel) return [];

    // 首选：消息行自带 data-id（false_xxx = 对方发来，true_xxx = 我发出）
    const rows = [];
    panel.querySelectorAll('[data-id]').forEach((el) => {
      const parentRow = el.parentElement && el.parentElement.closest('[data-id]');
      if (parentRow && parentRow !== el) return; // 只取最外层消息行
      rows.push(el);
    });
    if (rows.length) return rows;

    // 兜底：老选择器
    return Array.from(panel.querySelectorAll('.message-in, .message-out'));
  }

  function directionOf(el) {
    const id = el.getAttribute('data-id') || '';
    if (/^true_/.test(id)) return 'out';
    if (/^false_/.test(id)) return 'in';
    if (el.classList.contains('message-out') || el.closest('.message-out')) return 'out';
    if (el.classList.contains('message-in') || el.closest('.message-in')) return 'in';
    return 'in';
  }

  /** 取节点文本，自动剔除引用回复；detached 克隆用 textContent 兜底 */
  function textOf(node) {
    if (!node) return '';
    let src = node;
    if (node.querySelector && node.querySelector('.quoted-mention')) {
      const clone = node.cloneNode(true);
      clone.querySelectorAll('.quoted-mention').forEach((n) => n.remove());
      src = clone;
    }
    const t = src.innerText;
    return (t === undefined || t === null ? src.textContent || '' : t) || '';
  }

  /** 清理正文：去零宽字符、去尾部时间戳、压缩多余空白 */
  function cleanText(raw) {
    return String(raw || '')
      .replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s*\d{1,2}:\d{2}(\s*[APap][Mm])?\s*$/, '')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /** 兜底：找最内层的、文字最长的 [dir] 文本块 */
  function bestDirBlock(el) {
    const nodes = el.querySelectorAll('div[dir], span[dir], p[dir]');
    let best = null;
    let bestLen = 0;
    for (const n of nodes) {
      if (n.closest('.wat-blk')) continue;
      if (n.querySelector('div[dir], span[dir], p[dir]')) continue; // 只取最内层
      const t = (n.innerText || '').trim();
      if (t.length <= bestLen) continue;
      if (/^\d{1,2}:\d{2}(\s*[APap][Mm])?$/.test(t)) continue; // 纯时间戳
      if (t.length < 1) continue;
      best = n;
      bestLen = t.length;
    }
    return best;
  }

  /** 提取消息正文，并返回插入锚点 */
  function extract(el) {
    // A. data-pre-plain-text 正文容器
    const pre = el.querySelector('[data-pre-plain-text]');
    if (pre) {
      const t = cleanText(textOf(pre));
      if (t) return { text: t, anchor: pre, source: 'pre' };
    }

    // B. span.selectable-text
    const spans = el.querySelectorAll('span.selectable-text');
    if (spans.length) {
      const parts = [];
      let last = null;
      for (const s of spans) {
        if (s.closest('.quoted-mention')) continue;
        if (s.classList.contains('quoted-mention')) continue;
        if (s.closest('.wat-blk')) continue;
        const t = s.innerText || '';
        if (!t.trim()) continue;
        parts.push(t); // 保留原始空格，末尾统一 trim
        last = s;
      }
      if (last) {
        const anchor =
          last.closest('div.copyable-text') ||
          last.closest('div[class*="copyable"]') ||
          last.closest('div') ||
          last.parentElement;
        // 用空串拼接：@提及 等场景会把一句话拆成多个 span，换行会破坏句子
        const t = cleanText(parts.join(''));
        if (t) return { text: t, anchor, source: 'selectable-text' };
      }
    }

    // C. copyable-text 容器
    const cp = el.querySelector('.copyable-text');
    if (cp) {
      const t = cleanText(textOf(cp));
      if (t) return { text: t, anchor: cp, source: 'copyable-text' };
    }

    // D. 最内层文本块兜底
    const block = bestDirBlock(el);
    if (block) {
      const t = cleanText(block.innerText || block.textContent || '');
      if (t) return { text: t, anchor: block, source: 'dir-block' };
    }

    return { text: '', anchor: null, source: 'none' };
  }

  /* --------------------------------- 渲染 --------------------------------- */
  function paint(ctx, st) {
    const el = ctx.el;
    if (!el || !el.isConnected) return;

    let block = el.querySelector('.wat-blk');
    if (block && block.dataset.h === ctx.h && block.dataset.status === st.status && st.status !== 'done') return;

    if (!block) {
      if (!ctx.anchor || !ctx.anchor.isConnected) return;
      block = document.createElement('div');
      block.className = 'wat-blk';
      try {
        ctx.anchor.insertAdjacentElement('afterend', block);
      } catch (e) {
        (ctx.anchor.parentElement || el).appendChild(block);
      }
      // 双击译文块 = 用大模型精译（若用户正在选词复制则不打断）
      block.addEventListener('dblclick', (ev) => {
        const sel = window.getSelection();
        if (sel && String(sel).trim()) return;
        ev.preventDefault();
        ev.stopPropagation();
        if (block.__watCtx) refine(block.__watCtx);
      });
    }
    block.__watCtx = ctx;
    // 清理多余块
    const extras = el.querySelectorAll('.wat-blk');
    if (extras.length > 1) for (let i = 1; i < extras.length; i++) extras[i].remove();

    const lastKey = ctx.h + '|' + st.status + '|' + (st.text || '') + '|' + (st.lang || '') + '|' + (st.provider || '');
    if (block.dataset.key === lastKey) return;
    block.dataset.key = lastKey;

    block.dataset.h = ctx.h;
    block.dataset.status = st.status;
    block.textContent = '';

    if (st.status === 'pending') {
      const dots = document.createElement('span');
      dots.className = 'wat-dots';
      dots.innerHTML = '<i></i><i></i><i></i>';
      const hint = document.createElement('span');
      hint.className = 'wat-hint';
      hint.textContent = '翻译中…';
      block.append(dots, hint);
      return;
    }

    if (st.status === 'error') {
      const err = document.createElement('span');
      err.className = 'wat-err';
      err.textContent = '⚠ 翻译失败 · 点此重试';
      err.title = st.err || '';
      err.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        retry(ctx);
      });
      block.appendChild(err);
      return;
    }

    const tag = document.createElement('span');
    tag.className = 'wat-tag';
    const langLabel = S.showLangTag && st.lang
      ? ' · ' + (LANG_LABEL[st.lang] || String(st.lang).toUpperCase())
      : '';
    tag.textContent = '译' + langLabel;
    if (st.provider === 'llm') tag.title = st.refined ? 'AI 精译结果 · 点击可重新精译' : '由大模型翻译';
    else if (st.provider === 'deepl') tag.title = '由 DeepL 翻译 · 点击用 AI 精译';
    else if (st.provider === 'cache') tag.title = '来自本机缓存 · 点击用 AI 精译';
    else tag.title = '由 Google 翻译 · 点击用 AI 精译';
    // 点击语种标签 = 立即用大模型精译（更精确，走上下文 + 术语表）
    if (st.provider !== 'llm') {
      tag.classList.add('wat-tag-ai');
      tag.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        refine(ctx);
      });
    }

    const txt = document.createElement('span');
    txt.className = 'wat-text';
    txt.textContent = st.text;

    block.append(tag, txt);
  }

  function retry(ctx) {
    states.set(ctx.bid, { h: ctx.h, status: 'pending' });
    paint(ctx, states.get(ctx.bid));
    enqueue(ctx);
  }

  /** 双击译文块：强制用大模型、带上下文重译这一条 */
  function refine(ctx) {
    const st = states.get(ctx.bid);
    if (!st) return;
    const prevText = st.text;
    st.status = 'pending';
    paint(ctx, st);

    const done = (res) => {
      const cur = states.get(ctx.bid);
      if (!cur) return;
      if (res && res.ok && res.text) {
        cur.status = 'done';
        cur.text = res.text;
        cur.provider = 'llm';
        cur.refined = true;
        paint(ctx, cur);
        // 精译结果写回缓存：下次同一条消息直接显示校对后的版本
        const ck = cacheKey(S.target, ctx.text);
        memCache.set(ck, { text: res.text, lang: cur.lang || '' });
        bufferWrite(ck, res.text, cur.lang || '');
      } else {
        cur.status = 'error';
        cur.err = (res && res.error) || '精译失败，请检查大模型配置';
        cur.text = prevText || '';
        paint(ctx, cur);
      }
    };

    try {
      chrome.runtime.sendMessage(
        { type: 'wat:refine', text: ctx.text, target: S.target, context: ctx.context || [] },
        (res) => {
          if (chrome.runtime.lastError) done({ ok: false, error: '后台无响应，请重新加载插件' });
          else done(res || { ok: false, error: '空响应' });
        }
      );
    } catch (e) {
      done({ ok: false, error: String((e && e.message) || e) });
    }
  }

  /* --------------------------------- 翻译队列 -------------------------------- */
  function sendTranslate(text, context) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          {
            type: 'wat:translate',
            text,
            target: S.target,
            provider: S.provider,
            context: S.useContext === false ? [] : context || []
          },
          (res) => {
            if (chrome.runtime.lastError) {
              resolve({ ok: false, error: '后台无响应，请在扩展管理页重新加载插件' });
            } else {
              resolve(res || { ok: false, error: '空响应' });
            }
          }
        );
      } catch (e) {
        resolve({ ok: false, error: String((e && e.message) || e) });
      }
    });
  }

  function enqueue(ctx) {
    queue.push(ctx);
    pump();
  }

  function pump() {
    while (active < MAX_CONCURRENCY && queue.length) {
      const job = queue.shift();
      active++;
      runJob(job).finally(() => {
        active--;
        pump();
      });
    }
  }

  async function runJob(job) {
    try {
      // 同一段文本在其它会话/历史记录翻译过就直接复用
      const ck = cacheKey(S.target, job.text);
      const cached = memCache.get(ck);
      let res;
      if (cached) {
        res = { ok: true, text: cached.text, lang: cached.lang };
      } else {
        diag.requested++;
        res = await sendTranslate(job.text, job.context);
      }
      const st = states.get(job.bid);
      if (!st || st.h !== job.h) return; // 上下文已过期
      if (!res || !res.ok) throw new Error((res && res.error) || '未知错误');

      if (!cached) {
        memCache.set(ck, { text: res.text, lang: res.lang || '' });
        bufferWrite(ck, res.text, res.lang || '');
      }
      st.status = 'done';
      st.text = res.text;
      st.lang = res.lang || '';
      st.provider = res.provider;
      paint(job, st);
      statCount++;
    } catch (e) {
      diag.failed++;
      diag.lastError = String((e && e.message) || e);
      const st = states.get(job.bid);
      if (!st || st.h !== job.h) return;
      st.status = 'error';
      st.err = String((e && e.message) || e);
      paint(job, st);
    }
  }

  /* --------------------------------- 主流程 -------------------------------- */

  // 正文缓存：scan 时每条消息只解析一次，供「取上文」复用
  const textMemo = new Map();

  function textOfEl(el) {
    if (textMemo.has(el)) return textMemo.get(el);
    const got = extract(el);
    const v = got.text ? normalize(got.text) : '';
    textMemo.set(el, v);
    return v;
  }

  /**
   * 取同一会话里紧邻的前 N 条消息作为语境。
   * 这是消除「缺标点导致状语归属错误」的关键：单句机翻看不到上下文，
   * 大模型看到前文后能正确判断 "na segunda feira" 修饰的是哪一句。
   */
  function contextOf(list, index) {
    if (S.useContext === false) return [];
    const n = Math.max(0, Math.min(6, Number(S.contextCount) || 2));
    if (!n) return [];
    const out = [];
    for (let j = Math.max(0, index - n); j < index; j++) {
      const el = list[j];
      if (!el) continue;
      const t = textOfEl(el);
      if (!t) continue;
      out.push({ dir: directionOf(el), text: t.slice(0, 300) });
    }
    return out;
  }

  function handle(el, list, index) {
    const dir = directionOf(el);
    if (dir === 'out' && !S.translateOutgoing) {
      const old = el.querySelector('.wat-blk');
      if (old) old.remove();
      return;
    }
    const got = extract(el);
    if (got.source && got.source !== 'none') {
      diag.sources[got.source] = (diag.sources[got.source] || 0) + 1;
    }
    if (!got.text || !got.anchor) return;
    diag.withText++;
    const text = normalize(got.text);
    if (!shouldTranslate(text)) {
      diag.skipped++;
      return;
    }

    const idHost = el.closest('[data-id]') || el;
    const dataId = idHost.getAttribute('data-id') || 'h' + hash(text);
    const bid = dataId + '|' + S.target;
    const h = hash(text);
    const ctx = {
      el,
      anchor: got.anchor,
      bid,
      h,
      text,
      context: contextOf(list || [], index == null ? -1 : index)
    };

    const st = states.get(bid);
    if (st && st.h === h) {
      paint(ctx, st);
      return;
    }
    const fresh = { h, status: 'pending' };
    states.set(bid, fresh);
    paint(ctx, fresh);

    const cached = memCache.get(cacheKey(S.target, text));
    if (cached) {
      fresh.status = 'done';
      fresh.text = cached.text;
      fresh.lang = cached.lang;
      fresh.provider = 'cache';
      paint(ctx, fresh);
      return;
    }
    enqueue(ctx);
  }

  function scan() {
    if (!S.enabled) return;
    const els = Array.from(collectMessageEls());
    if (textMemo.size > 800) textMemo.clear();
    diag.rows = els.length;
    diag.withText = 0;
    diag.skipped = 0;
    for (let i = 0; i < els.length; i++) {
      try {
        handle(els[i], els, i);
      } catch (e) {
        /* 单条消息异常不影响其它消息 */
      }
    }
  }

  let scheduled = false;
  function scheduleScan() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      scan();
    }, 120);
  }

  /* -------------------------------- 缓存持久化 ------------------------------- */
  let flushTimer = null;
  function bufferWrite(key, text, lang) {
    writeBuffer[key] = { t: text, l: lang, ts: Date.now() };
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const patch = Object.assign({}, writeBuffer);
      Object.keys(writeBuffer).forEach((k) => delete writeBuffer[k]);
      chrome.storage.local.get(['wat_cache'], (got) => {
        let cache = (got && got.wat_cache) || {};
        Object.assign(cache, patch);
        const keys = Object.keys(cache);
        if (keys.length > CACHE_LIMIT) {
          keys
            .sort((a, b) => (cache[a].ts || 0) - (cache[b].ts || 0))
            .slice(0, keys.length - CACHE_LIMIT)
            .forEach((k) => delete cache[k]);
        }
        chrome.storage.local.set({ wat_cache: cache });
      });
    }, 1500);
  }

  function loadCache() {
    try {
      chrome.storage.local.get(['wat_cache'], (got) => {
        const cache = (got && got.wat_cache) || {};
        Object.keys(cache).forEach((k) => {
          const v = cache[k];
          if (v && v.t) memCache.set(k, { text: v.t, lang: v.l || '' });
        });
        scheduleScan();
      });
    } catch (e) {
      /* ignore */
    }
  }

  /* -------------------------------- 设置同步 ------------------------------- */
  function readSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(null, (got) => {
        resolve(Object.assign({}, DEFAULTS, got || {}));
      });
    });
  }

  function resetAll() {
    states.clear();
    queue.length = 0;
    document.querySelectorAll('.wat-blk').forEach((n) => n.remove());
  }

  async function boot() {
    S = await readSettings();
    loadCache();

    // 监听新消息
    const observer = new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type !== 'childList') continue;
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          if (n.classList && n.classList.contains('wat-blk')) continue;
          // 只有疑似消息节点才触发全量扫描，避免“正在输入”等高频变动引起抖动
          const isMsg =
            (n.matches && n.matches('[data-id], .message-in, .message-out')) ||
            (n.querySelector && n.querySelector('[data-id], .message-in, .message-out'));
          if (isMsg) {
            scheduleScan();
            return;
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // 兜底轮询：WhatsApp 会做 DOM 复用 / 虚拟滚动
    setInterval(() => {
      if (S.enabled && !document.hidden) scan();
    }, 3000);

    if (S.enabled) scan();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    const keys = Object.keys(changes);
    if (!keys.some((k) => k in DEFAULTS)) return;
    readSettings().then(async (next) => {
      // 换引擎、或改动了上下文策略后，旧译文不再可信 → 连缓存一起清掉重译
      const dropCache =
        next.provider !== S.provider ||
        next.useContext !== S.useContext ||
        next.contextCount !== S.contextCount;
      const needReset =
        next.target !== S.target ||
        next.translateOutgoing !== S.translateOutgoing ||
        next.provider !== S.provider ||
        next.showLangTag !== S.showLangTag ||
        next.useContext !== S.useContext ||
        next.contextCount !== S.contextCount;
      S = next;
      if (!S.enabled) {
        resetAll();
        return;
      }
      if (dropCache) {
        memCache.clear();
        try {
          chrome.storage.local.set({ wat_cache: {} });
        } catch (e) {
          /* ignore */
        }
      }
      if (needReset) resetAll();
      scheduleScan();
    });
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'wat:stats') {
      try {
        scan(); // 打开弹窗时顺手扫一遍，状态更实时
      } catch (e) {
        /* ignore */
      }
      sendResponse({
        ok: true,
        enabled: S.enabled,
        target: S.target,
        provider: S.provider,
        translated: statCount,
        cache: memCache.size,
        pending: queue.length + active,
        rows: diag.rows,
        withText: diag.withText,
        failed: diag.failed
      });
      return;
    }
    if (msg && msg.type === 'wat:clear-mem') {
      memCache.clear();
      sendResponse({ ok: true });
      return;
    }
    if (msg && msg.type === 'wat:diag') {
      const els = collectMessageEls();
      const samples = els.slice(0, 4).map((el) => {
        const got = extract(el);
        return {
          id: el.getAttribute('data-id') || '(无 data-id)',
          dir: directionOf(el),
          source: got.source,
          text: (got.text || '').slice(0, 120),
          hasPre: !!el.querySelector('[data-pre-plain-text]'),
          hasSelectable: !!el.querySelector('.selectable-text'),
          html: (el.outerHTML || '').slice(0, 800)
        };
      });
      const panel = getPanel();
      sendResponse({
        ok: true,
        enabled: S.enabled,
        target: S.target,
        provider: S.provider,
        panelFound: !!panel,
        panelName: panel ? panel.id || panel.getAttribute('data-testid') || panel.tagName : '',
        diag: Object.assign({}, diag, {
          sources: Object.assign({}, diag.sources),
          blocks: document.querySelectorAll('.wat-blk').length,
          translated: statCount,
          pending: queue.length + active
        }),
        panelHtml: panel ? panel.innerHTML.slice(0, 1500) : '',
        samples
      });
      return;
    }
  });

  boot();
})();
