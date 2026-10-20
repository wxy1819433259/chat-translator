const $ = (id) => document.getElementById(id);

let lastReport = null;

function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function findWaTab(cb) {
  chrome.tabs.query({}, (tabs) => {
    const list = (tabs || []).filter((t) => t.url && t.url.indexOf('web.whatsapp.com') > -1);
    cb(list[0] || null);
  });
}

function setVerdict(kind, html) {
  const el = $('verdict');
  el.className = 'verdict' + (kind ? ' ' + kind : '');
  el.innerHTML = html;
}

function renderNoTab() {
  setVerdict('bad', '<b>没有找到 WhatsApp 页面</b><br>请先在 Chrome 里打开 <code>web.whatsapp.com</code> 并进入一个聊天，再点「重新检测」。');
  $('kv').innerHTML = '';
  $('samples').innerHTML = '';
  lastReport = null;
}

function renderNotInjected(url) {
  setVerdict('bad', '<b>插件没有注入到这个页面</b><br>通常是安装插件之前页面就已经打开了。<br>请在 WhatsApp 页面按 <b>F5 刷新</b>一次，再点「重新检测」。');
  $('kv').innerHTML = '<dt>页面</dt><dd>' + esc(url) + '</dd>';
  $('samples').innerHTML = '';
  lastReport = null;
}

function render(res, tab) {
  const d = res.diag || {};
  lastReport = { url: tab.url, version: chrome.runtime.getManifest().version, report: res };

  const rows = [
    ['页面', esc(tab.url)],
    ['插件状态', res.enabled ? '<b>已开启</b>' : '已关闭'],
    ['翻译引擎', esc(res.provider) + ' → ' + esc(res.target)],
    ['消息面板', res.panelFound ? '已找到（' + esc(res.panelName) + '）' : '<span style="color:#d93025">没找到 #main</span>'],
    ['消息行数', '<b>' + (d.rows || 0) + '</b>'],
    ['能取到正文', '<b>' + (d.withText || 0) + '</b> 条'],
    ['被规则跳过', (d.skipped || 0) + ' 条（中文/表情/纯链接）'],
    ['已插入译文块', (d.blocks || 0) + ' 个'],
    ['翻译成功', (d.translated || 0) + ' 条'],
    ['发出请求', (d.requested || 0) + ' 次，失败 ' + (d.failed || 0) + ' 次'],
    ['识别策略', esc(JSON.stringify(d.sources || {}))],
    ['最后错误', d.lastError ? '<span style="color:#d93025">' + esc(d.lastError) + '</span>' : '无']
  ];
  $('kv').innerHTML = rows.map(([k, v]) => '<dt>' + k + '</dt><dd>' + v + '</dd>').join('');

  /* ---- 结论 ---- */
  if (!res.enabled) {
    setVerdict('bad', '<b>翻译开关是关的</b><br>点浏览器工具栏里的插件图标，把右上角的开关打开。');
  } else if (!res.panelFound) {
    setVerdict('bad', '<b>页面上找不到聊天面板</b><br>可能是还停在扫码界面，或者 WhatsApp 换了页面结构。请先打开任意一个聊天窗口再检测。');
  } else if (!d.rows) {
    setVerdict('bad', '<b>一条消息都没找到</b><br>插件找不到消息节点，说明当前 WhatsApp 版本的页面结构已经变化。<br>请点「复制完整报告」发给开发者，报告里带了页面结构样本，可以直接定位。');
  } else if (!d.withText) {
    setVerdict('bad', '<b>找到了 ' + d.rows + ' 条消息，但取不到正文</b><br>这是典型的「WhatsApp 改版、正文容器选择器失效」。下面的样本里 <code>html</code> 就是真实结构，复制报告发出来即可修好。');
  } else if (d.failed && !d.blocks) {
    setVerdict('bad', '<b>取到了正文，但翻译接口全部失败</b><br>错误：' + esc(d.lastError || '未知') + '<br>检查一下网络 / 代理，或到设置里换个翻译引擎。');
  } else if (!d.blocks && d.withText === d.skipped) {
    setVerdict('', '<b>当前窗口的消息都被规则跳过了</b><br>只有中文、纯表情、纯链接或纯数字的消息不会翻译。换一个有外语消息的聊天再试。');
  } else if (d.blocks) {
    setVerdict('good', '<b>运行正常</b><br>已识别 ' + d.rows + ' 条消息，插入 ' + d.blocks + ' 个译文块。如果某条消息没有译文，多半是被规则跳过或还在翻译中。');
  } else {
    setVerdict('', '<b>正在翻译…</b><br>识别到 ' + d.rows + ' 条消息，已发出 ' + (d.requested || 0) + ' 个请求，稍等一秒再点「重新检测」。');
  }

  /* ---- 样本 ---- */
  const list = res.samples || [];
  if (!list.length) {
    $('samples').innerHTML = '<p class="hint">没有样本。页面结构参考：<br><code>' +
      esc((res.panelHtml || '(空)').slice(0, 800)) + '</code></p>';
    return;
  }
  $('samples').innerHTML = list.map((s, i) => {
    const tags = [
      '<span class="tag' + (s.hasPre ? '' : ' off') + '">data-pre-plain-text</span>',
      '<span class="tag' + (s.hasSelectable ? '' : ' off') + '">selectable-text</span>',
      '<span class="tag">' + esc(s.dir) + '</span>',
      '<span class="tag">' + esc(s.source) + '</span>'
    ].join('');
    return '<div class="sample">' +
      '<div class="id">#' + (i + 1) + ' ' + esc(s.id) + '</div>' +
      '<div class="tags">' + tags + '</div>' +
      '<div class="txt">' + (s.text ? '正文：<b>' + esc(s.text) + '</b>' : '<span style="color:#d93025">正文：取不到</span>') + '</div>' +
      '<details><summary>查看 HTML 结构</summary><pre>' + esc(s.html) + '</pre></details>' +
      '</div>';
  }).join('');
}

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1300);
}

$('refresh').addEventListener('click', refresh);
$('copy').addEventListener('click', () => {
  if (!lastReport) {
    toast('还没有报告可复制');
    return;
  }
  const text = JSON.stringify(Object.assign({ time: new Date().toLocaleString() }, lastReport), null, 2);
  navigator.clipboard.writeText(text).then(
    () => toast('已复制，发给开发者即可'),
    () => {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast('已复制');
    }
  );
});

function refresh() {
  findWaTab((tab) => {
    if (!tab) return renderNoTab();
    chrome.tabs.sendMessage(tab.id, { type: 'wat:diag' }, (res) => {
      if (chrome.runtime.lastError || !res || !res.ok) return renderNotInjected(tab.url);
      render(res, tab);
    });
  });
}

refresh();
setInterval(() => {
  if (!document.hidden) refresh();
}, 3000);
