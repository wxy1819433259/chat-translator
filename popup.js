const DEFAULTS = {
  enabled: true,
  target: 'zh-CN',
  provider: 'google',
  translateOutgoing: false,
  showLangTag: true,
  useContext: true
};

const $ = (id) => document.getElementById(id);

function loadSettings() {
  chrome.storage.sync.get(null, (got) => {
    const s = Object.assign({}, DEFAULTS, got || {});
    $('enabled').checked = !!s.enabled;
    $('target').value = s.target || 'zh-CN';
    $('provider').value = s.provider || 'google';
    $('translateOutgoing').checked = !!s.translateOutgoing;
    $('showLangTag').checked = !!s.showLangTag;
    $('useContext').checked = s.useContext !== false;
    // 不是大模型时，提示一句"精度还可以再高"
    $('precisionHint').hidden = (s.provider || 'google') === 'llm';
    paintStatus();
  });
}

function save(patch) {
  chrome.storage.sync.set(patch, () => {
    loadSettings();
  });
}

['enabled', 'translateOutgoing', 'showLangTag', 'useContext'].forEach((id) => {
  $(id).addEventListener('change', () => save({ [id]: $(id).checked }));
});

['target', 'provider'].forEach((id) => {
  $(id).addEventListener('change', () => save({ [id]: $(id).value }));
});

$('upgradeEngine').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

$('openOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

$('openDiag').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('diagnose.html') });
});

$('clearCache').addEventListener('click', () => {
  chrome.storage.local.set({ wat_cache: {} }, () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (tab && tab.id) chrome.tabs.sendMessage(tab.id, { type: 'wat:clear-mem' }, () => void chrome.runtime.lastError);
    });
    $('clearCache').textContent = '已清空 ✓';
    setTimeout(() => ($('clearCache').textContent = '清空缓存'), 1400);
  });
});

function paintStatus() {
  const bar = $('statusBar');
  const text = $('statusText');
  const count = $('statusCount');
  bar.className = 'status';
  count.textContent = '';
  count.title = '';

  if (!$('enabled').checked) {
    bar.classList.add('off');
    text.textContent = '翻译已关闭';
    text.title = '';
    return;
  }

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    const isWA = tab && tab.url && tab.url.indexOf('web.whatsapp.com') > -1;
    if (!isWA) {
      text.textContent = '请打开 WhatsApp Web 聊天页';
      text.title = '';
      return;
    }
    chrome.tabs.sendMessage(tab.id, { type: 'wat:stats' }, (res) => {
      if (chrome.runtime.lastError || !res || !res.ok) {
        text.textContent = '已安装，请刷新 WhatsApp 页面';
        text.title = '';
        return;
      }
      const engine = engineName(res.provider);
      if (res.failed > 0 && !res.translated) {
        text.textContent = '翻译接口失败 ' + res.failed + ' 次 · 点「诊断」';
        text.title = '';
        return;
      }
      if (!res.withText) {
        text.textContent = '运行中 · ' + engine + ' · 未识别到消息';
        text.title = '当前窗口里没有找到带文字的消息气泡';
        count.textContent = '消息 ' + (res.rows || 0) + ' 条';
        count.title = '聊天区渲染出来的消息行数';
        return;
      }
      bar.classList.add('on');
      // 左边「当前多少条」= 此刻屏幕上渲染出的消息数（WhatsApp 只渲染视口附近）
      // 右边「累计多少条」= 本次打开页面以来翻译成功过的总数（只增不减）
      text.textContent = '运行中 · ' + engine + ' · 当前 ' + res.withText + ' 条';
      text.title =
        '当前聊天区里渲染出来的消息条数。WhatsApp 只渲染屏幕附近的几条，' +
        '滚动聊天时会跟着变化，这是正常的。';
      count.textContent = '累计 ' + res.translated + ' 条';
      count.title =
        '本次打开 WhatsApp 以来，累计翻译成功的消息条数（只增不减）。' +
        '滚动查看历史消息时会继续增加，所以它通常比左边的「当前」多得多。';
    });
  });
}

function engineName(p) {
  if (p === 'deepl') return 'DeepL';
  if (p === 'llm') return '大模型';
  return 'Google';
}

loadSettings();
