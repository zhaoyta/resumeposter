import { getSettings, saveSettings } from '../lib/storage.js';
import { extractResumeText } from '../lib/resume-file.js';

const $ = (id) => document.getElementById(id);

let saveTimer = null;
let saving = false;

function setStatus(msg, isError = false) {
  const el = $('status');
  el.textContent = msg;
  el.classList.toggle('error', isError);
}

async function send(type, payload) {
  const res = await chrome.runtime.sendMessage({ type, payload });
  if (!res?.ok) throw new Error(res?.error || '请求失败');
  return res.data;
}

function fillForm(settings) {
  $('apiBase').value = settings.apiBase || '';
  $('apiKey').value = settings.apiKey || '';
  $('model').value = settings.model || 'deepseek-chat';
  $('criteriaText').value = settings.criteriaText || '';
  $('searchKeywords').value = settings.searchKeywords || '';
  $('excludeKeywords').value = settings.excludeKeywords || '';
  $('resumeText').value = settings.resumeText || '';
  $('matchThreshold').value = settings.matchThreshold ?? 70;
  $('thresholdVal').textContent = String(settings.matchThreshold ?? 70);
  $('resumeName').textContent = settings.resumeName
    ? `已加载：${settings.resumeName}`
    : settings.resumeText
      ? '已有粘贴文本'
      : '未选择文件';
  $('summaryPreview').textContent = settings.resumeSummary
    ? `摘要已缓存（${settings.resumeSummary.length} 字）`
    : '尚未生成简历摘要';
}

function readForm() {
  const name = $('resumeName').textContent.startsWith('已加载：')
    ? $('resumeName').textContent.replace('已加载：', '')
    : undefined;
  return {
    apiBase: $('apiBase').value.trim() || 'https://api.deepseek.com',
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim() || 'deepseek-chat',
    criteriaText: $('criteriaText').value.trim(),
    searchKeywords: $('searchKeywords').value.trim(),
    excludeKeywords: $('excludeKeywords').value.trim(),
    resumeText: $('resumeText').value,
    matchThreshold: Number($('matchThreshold').value) || 70,
    ...(name ? { resumeName: name } : {})
  };
}

async function persist(showMsg = true) {
  if (saving) return;
  saving = true;
  try {
    await saveSettings(readForm());
    if (showMsg) setStatus('已自动保存到本地');
  } catch (err) {
    setStatus(err.message || String(err), true);
  } finally {
    saving = false;
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  setStatus('正在保存…');
  saveTimer = setTimeout(() => {
    persist(true).catch(() => {});
  }, 400);
}

function bindAutoSave() {
  const ids = [
    'apiBase',
    'apiKey',
    'model',
    'criteriaText',
    'searchKeywords',
    'excludeKeywords',
    'resumeText',
    'matchThreshold'
  ];
  for (const id of ids) {
    const el = $(id);
    const evt = id === 'matchThreshold' ? 'change' : 'input';
    el.addEventListener(evt, () => {
      if (id === 'matchThreshold') {
        $('thresholdVal').textContent = el.value;
      }
      scheduleSave();
    });
  }

  // 弹窗关闭前尽量落盘
  window.addEventListener('pagehide', () => {
    clearTimeout(saveTimer);
    // 同步触发；chrome.storage 仍是异步，但立刻发起
    void saveSettings(readForm());
  });
}

async function init() {
  const settings = await getSettings();
  fillForm(settings);
  bindAutoSave();

  $('resumeFile').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setStatus(`正在解析 ${file.name}…`);
      const text = await extractResumeText(file);
      $('resumeText').value = text;
      $('resumeName').textContent = `已加载：${file.name}`;
      await saveSettings({
        ...readForm(),
        resumeText: text,
        resumeName: file.name,
        resumeSummary: ''
      });
      $('summaryPreview').textContent = '简历已更新，请重新生成摘要';
      setStatus(`已读取并保存 ${file.name}（${text.length} 字）`);
    } catch (err) {
      setStatus(err.message || String(err), true);
      e.target.value = '';
    }
  });

  $('btnSave').addEventListener('click', async () => {
    clearTimeout(saveTimer);
    await persist(true);
  });

  $('btnSummarize').addEventListener('click', async () => {
    try {
      clearTimeout(saveTimer);
      setStatus('正在生成简历摘要…');
      await persist(false);
      const data = await send('SUMMARIZE_RESUME', {
        resumeText: $('resumeText').value
      });
      $('summaryPreview').textContent = `摘要已缓存（${data.resumeSummary.length} 字）`;
      setStatus(`摘要完成：\n${data.resumeSummary.slice(0, 300)}`);
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  $('btnMap').addEventListener('click', async () => {
    try {
      clearTimeout(saveTimer);
      setStatus('正在映射筛选项…');
      await persist(false);
      const filters = await send('MAP_FILTERS', {
        criteriaText: $('criteriaText').value
      });
      const box = $('filterPreview');
      box.hidden = false;
      box.textContent = JSON.stringify(filters, null, 2);
      setStatus('筛选项预览已生成（阶段1仅预览，不自动点页面）');
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  $('btnGenKeywords').addEventListener('click', async () => {
    try {
      clearTimeout(saveTimer);
      setStatus('正在根据简历生成搜索关键词…');
      await persist(false);
      const data = await send('GENERATE_KEYWORDS', {
        resumeText: $('resumeText').value,
        criteriaText: $('criteriaText').value
      });
      $('searchKeywords').value = data.keywords.join('\n');
      await persist(false);
      setStatus(
        `已生成 ${data.keywords.length} 个关键词并保存：\n${data.keywords.join('、')}${
          data.reason ? `\n${data.reason}` : ''
        }`
      );
    } catch (err) {
      setStatus(err.message, true);
    }
  });

  $('linkHistory').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('history/history.html') });
  });

  if (settings.apiKey || settings.resumeText || settings.criteriaText) {
    setStatus('已从本地恢复配置');
  } else {
    setStatus('填写后会自动保存到本地');
  }
}

init().catch((err) => setStatus(err.message, true));
