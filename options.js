const DEFAULTS = {
  enabled: true,
  target: 'zh-CN',
  provider: 'google',
  translateOutgoing: false,
  showLangTag: true,
  maxChars: 3000,
  useContext: true,
  contextCount: 2,
  glossary: '',
  llm: { baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat', systemPrompt: '' },
  deepl: { apiKey: '' }
};

const $ = (id) => document.getElementById(id);

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg || '已保存';
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1300);
}

/* ------------------------------- 读取 / 写入 ------------------------------- */
function load() {
  chrome.storage.sync.get(null, (got) => {
    const s = Object.assign({}, DEFAULTS, got || {});
    s.llm = Object.assign({}, DEFAULTS.llm, (got && got.llm) || {});
    s.deepl = Object.assign({}, DEFAULTS.deepl, (got && got.deepl) || {});

    $('enabled').checked = !!s.enabled;
    $('target').value = s.target || 'zh-CN';
    $('translateOutgoing').checked = !!s.translateOutgoing;
    $('showLangTag').checked = !!s.showLangTag;
    $('maxChars').value = s.maxChars || 3000;
    $('useContext').checked = s.useContext !== false;
    $('contextCount').value = String(s.contextCount == null ? 2 : s.contextCount);
    $('glossary').value = s.glossary || '';

    const radios = document.querySelectorAll('input[name="provider"]');
    radios.forEach((r) => (r.checked = r.value === (s.provider || 'google')));
    syncPanels();

    $('deeplKey').value = s.deepl.apiKey || '';
    $('llmBase').value = s.llm.baseUrl || '';
    $('llmKey').value = s.llm.apiKey || '';
    $('llmModel').value = s.llm.model || '';
    $('llmPrompt').value = s.llm.systemPrompt || '';
  });
}

function patch(obj) {
  chrome.storage.sync.set(obj, () => {
    if (chrome.runtime.lastError) toast('保存失败：' + chrome.runtime.lastError.message);
    else toast('已保存');
  });
}

function syncPanels() {
  const p = document.querySelector('input[name="provider"]:checked');
  const cur = p ? p.value : 'google';
  $('panel-deepl').classList.toggle('show', cur === 'deepl');
  $('panel-llm').classList.toggle('show', cur === 'llm');
}

/* --------------------------------- 绑定 --------------------------------- */
$('enabled').addEventListener('change', () => patch({ enabled: $('enabled').checked }));
$('translateOutgoing').addEventListener('change', () => patch({ translateOutgoing: $('translateOutgoing').checked }));
$('showLangTag').addEventListener('change', () => patch({ showLangTag: $('showLangTag').checked }));
$('target').addEventListener('change', () => patch({ target: $('target').value }));

$('maxChars').addEventListener('change', () => {
  let v = parseInt($('maxChars').value, 10);
  if (!v || v < 200) v = 200;
  if (v > 6000) v = 6000;
  $('maxChars').value = v;
  patch({ maxChars: v });
});

document.querySelectorAll('input[name="provider"]').forEach((r) => {
  r.addEventListener('change', () => {
    syncPanels();
    patch({ provider: r.value });
  });
});

let saveTimer = null;
function saveLlmSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    patch({
      llm: {
        baseUrl: $('llmBase').value.trim(),
        apiKey: $('llmKey').value.trim(),
        model: $('llmModel').value.trim(),
        systemPrompt: $('llmPrompt').value.trim()
      }
    });
  }, 500);
}

['llmBase', 'llmKey', 'llmModel', 'llmPrompt'].forEach((id) => {
  $(id).addEventListener('input', saveLlmSoon);
  $(id).addEventListener('blur', () => {
    clearTimeout(saveTimer);
    patch({
      llm: {
        baseUrl: $('llmBase').value.trim(),
        apiKey: $('llmKey').value.trim(),
        model: $('llmModel').value.trim(),
        systemPrompt: $('llmPrompt').value.trim()
      }
    });
  });
});

$('deeplKey').addEventListener('change', () => {
  patch({ deepl: { apiKey: $('deeplKey').value.trim() } });
});

$('useContext').addEventListener('change', () => {
  patch({ useContext: $('useContext').checked, contextCount: parseInt($('contextCount').value, 10) || 0 });
});

$('contextCount').addEventListener('change', () => {
  patch({ contextCount: parseInt($('contextCount').value, 10) || 0, useContext: $('useContext').checked });
});

let glossaryTimer = null;
function saveGlossarySoon() {
  clearTimeout(glossaryTimer);
  glossaryTimer = setTimeout(() => patch({ glossary: $('glossary').value }), 600);
}
$('glossary').addEventListener('input', saveGlossarySoon);
$('glossary').addEventListener('blur', () => {
  clearTimeout(glossaryTimer);
  patch({ glossary: $('glossary').value });
});

/* ------------------------------ 权限与测试连接 ------------------------------ */
function ensureOriginPermission(url) {
  return new Promise((resolve) => {
    let origin;
    try {
      origin = new URL(url).origin;
    } catch (e) {
      resolve(false);
      return;
    }
    const pattern = origin + '/*';
    chrome.permissions.contains({ origins: [pattern] }, (has) => {
      if (has) return resolve(true);
      chrome.permissions.request({ origins: [pattern] }, (granted) => {
        if (chrome.runtime.lastError) return resolve(false);
        resolve(!!granted);
      });
    });
  });
}

function sendMsg(payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(payload, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: '后台无响应，请重新加载扩展' });
        return;
      }
      resolve(res || { ok: false, error: '空响应' });
    });
  });
}

const ENGINE_LABEL = { google: 'Google', deepl: 'DeepL', llm: '大模型' };

function renderTestRows(rows) {
  const out = $('testResult');
  out.className = 'test-result';
  out.textContent = '';
  rows.forEach((r) => {
    const line = document.createElement('div');
    line.className = 'test-line ' + (r.cls || '');
    const k = document.createElement('span');
    k.className = 'test-k';
    k.textContent = r.k;
    const v = document.createElement('span');
    v.className = 'test-v';
    v.textContent = r.v;
    line.append(k, v);
    out.appendChild(line);
  });
}

$('test').addEventListener('click', async () => {
  const btn = $('test');
  const p = document.querySelector('input[name="provider"]:checked');
  const provider = p ? p.value : 'google';
  const target = $('target').value || 'zh-CN';

  // 用一句典型的「缺标点 + 状语歧义」葡语做样本，能直接看出精度差异
  const sample = 'Olá desculpe a demora na segunda feira vejo isso';
  const context = [
    { dir: 'in', text: 'Bom dia, conseguiu verificar minha cotação?' },
    { dir: 'out', text: 'Ainda não, retorno hoje.' }
  ];

  btn.disabled = true;
  renderTestRows([{ k: '测试中', v: '正在用真实消息样例对比引擎精度…' }]);

  if (provider === 'llm' || provider === 'deepl') {
    const base = provider === 'llm' ? $('llmBase').value.trim() : '';
    if (base) await ensureOriginPermission(base);
  }

  const rows = [];
  const main = await sendMsg({ type: 'wat:test', provider, target, sample, context });
  if (main.ok) {
    rows.push({
      k: ENGINE_LABEL[provider] || provider,
      v: main.text,
      cls: provider === 'llm' ? 'best' : ''
    });
  } else {
    rows.push({ k: ENGINE_LABEL[provider] || provider, v: '失败：' + (main.error || '未知错误'), cls: 'bad' });
  }

  // 当前不是大模型，但填了 Key → 顺手跑一次对比，让差距可见
  const hasLlmKey = $('llmKey').value.trim();
  if (provider !== 'llm' && hasLlmKey && $('llmBase').value.trim()) {
    renderTestRows(rows.concat([{ k: '大模型', v: '对比中…' }]));
    await ensureOriginPermission($('llmBase').value.trim());
    const cmp = await sendMsg({ type: 'wat:test', provider: 'llm', target, sample, context });
    if (cmp.ok) rows.push({ k: '大模型', v: cmp.text, cls: 'best' });
    else rows.push({ k: '大模型', v: '失败：' + (cmp.error || '未知错误'), cls: 'bad' });
  }

  renderTestRows(rows);
  btn.disabled = false;
});

/* --------------------------------- 缓存 --------------------------------- */
function refreshCacheInfo() {
  chrome.storage.local.get(['wat_cache'], (got) => {
    const n = Object.keys((got && got.wat_cache) || {}).length;
    $('cacheInfo').textContent = n ? '本机已缓存 ' + n + ' 条译文' : '暂无缓存';
  });
}

$('clearCache').addEventListener('click', () => {
  chrome.storage.local.set({ wat_cache: {} }, () => {
    chrome.tabs.query({}, (tabs) => {
      (tabs || []).forEach((t) => {
        if (t.url && t.url.indexOf('web.whatsapp.com') > -1 && t.id) {
          chrome.tabs.sendMessage(t.id, { type: 'wat:clear-mem' }, () => void chrome.runtime.lastError);
        }
      });
    });
    refreshCacheInfo();
    toast('缓存已清空');
  });
});

load();
refreshCacheInfo();
