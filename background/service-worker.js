import {
  getSettings,
  saveSettings,
  getMatchRecords,
  getMatchRecordsWithGreet,
  upsertMatchRecord,
  clearMatchRecords,
  getResultList,
  saveResultList,
  clearResultList,
  getGreetStats,
  recordGreetSuccess,
  markResultGreeted
} from '../lib/storage.js';
import {
  summarizeResume,
  matchJob,
  matchJobsBatch,
  mapSearchFilters,
  generateSearchKeywords
} from '../lib/deepseek.js';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
  return true;
});

async function handleMessage(message) {
  const { type, payload } = message || {};

  switch (type) {
    case 'GET_SETTINGS':
      return getSettings();

    case 'SAVE_SETTINGS':
      return saveSettings(payload || {});

    case 'SAVE_PANEL_OPTIONS':
      return saveSettings({
        panelPages: Math.min(30, Math.max(1, Number(payload?.panelPages) || 10)),
        panelDoFilter: Boolean(payload?.panelDoFilter),
        ...(payload?.searchKeywords != null ? { searchKeywords: String(payload.searchKeywords) } : {}),
        ...(payload?.greetDailyLimit != null
          ? { greetDailyLimit: Math.min(500, Math.max(1, Number(payload.greetDailyLimit) || 25)) }
          : {}),
        ...(payload?.greetIntervalMinSec != null
          ? {
              greetIntervalMinSec: Math.min(
                300,
                Math.max(1, Number(payload.greetIntervalMinSec) || 5)
              )
            }
          : {}),
        ...(payload?.greetIntervalMaxSec != null
          ? {
              greetIntervalMaxSec: Math.min(
                600,
                Math.max(1, Number(payload.greetIntervalMaxSec) || 10)
              )
            }
          : {})
      });

    case 'GET_GREET_QUOTA': {
      const settings = await getSettings();
      const stats = await getGreetStats();
      const limit = Number(settings.greetDailyLimit) || 25;
      return {
        date: stats.date,
        used: stats.count,
        limit,
        remain: Math.max(0, limit - stats.count),
        intervalMinSec: Number(settings.greetIntervalMinSec) || 5,
        intervalMaxSec: Number(settings.greetIntervalMaxSec) || 10,
        burstEvery: 0,
        burstPauseSec: 0
      };
    }

    case 'RECORD_GREET_SUCCESS':
      return recordGreetSuccess(Number(payload?.n) || 1);

    case 'SUMMARIZE_RESUME': {
      const settings = await getSettings();
      const text = payload?.resumeText || settings.resumeText;
      if (!text?.trim()) throw new Error('请先上传或粘贴简历文本');
      const summaryObj = await summarizeResume(settings, text);
      const resumeSummary = [
        summaryObj.summary || '',
        `技能: ${(summaryObj.skills || []).join(', ')}`,
        `年限: ${summaryObj.years || ''}`,
        `目标: ${(summaryObj.targetRoles || []).join(', ')}`,
        `回避: ${(summaryObj.avoid || []).join(', ')}`
      ]
        .filter(Boolean)
        .join('\n');
      await saveSettings({ resumeSummary, resumeText: text });
      return { resumeSummary, raw: summaryObj };
    }

    case 'MATCH_JOB': {
      const settings = await getSettings();
      ensureResume(settings);
      const job = payload?.job;
      if (!job?.description && !job?.title) {
        throw new Error('未获取到职位信息');
      }
      const result = await matchSingle(settings, job, payload?.pageUrl);
      return result;
    }

    case 'MATCH_JOBS_BATCH': {
      const settings = await getSettings();
      ensureResume(settings);
      const jobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
      if (!jobs.length) throw new Error('没有待匹配职位');

      const excludes = parseExcludes(settings);
      const pre = [];
      const needModel = [];

      for (const job of jobs) {
        const hit = hitExclude(job, excludes);
        if (hit) {
          const result = {
            score: 15,
            recommend: false,
            reason: `命中排除关键词「${hit}」`,
            pros: [],
            cons: [`包含排除词: ${hit}`],
            missing: []
          };
          pre.push({ job, result });
          await upsertMatchRecord(buildRecord(job, result, payload?.pageUrl));
        } else {
          needModel.push(job);
        }
      }

      const batchResults = [];
      const chunkSize = 8;
      for (let i = 0; i < needModel.length; i += chunkSize) {
        const chunk = needModel.slice(i, i + chunkSize);
        const scored = await matchJobsBatch(settings, {
          resumeSummary: settings.resumeSummary,
          resumeText: settings.resumeText,
          criteriaText: settings.criteriaText,
          jobs: chunk
        });
        for (let k = 0; k < chunk.length; k++) {
          const job = chunk[k];
          const result = scored[k] || {
            score: 0,
            recommend: false,
            reason: '无结果',
            pros: [],
            cons: [],
            missing: []
          };
          batchResults.push({ job, result });
          await upsertMatchRecord(buildRecord(job, result, payload?.pageUrl));
        }
      }

      const merged = [...pre, ...batchResults];
      const rows = merged
        .map(({ job, result }) => ({
          ...buildRecord(job, result, payload?.pageUrl),
          tags: job.tags || [],
          description: (job.description || '').slice(0, 500)
        }))
        .sort((a, b) => (b.score || 0) - (a.score || 0));

      // 与已有结果合并；保留已招呼标记
      const old = await getResultList();
      const map = new Map(old.map((r) => [r.jobId || `${r.title}|${r.company}`, r]));
      for (const r of rows) {
        const key = r.jobId || `${r.title}|${r.company}`;
        const prev = map.get(key);
        map.set(key, {
          ...r,
          ...(prev?.greeted
            ? {
                greeted: prev.greeted,
                greetedAt: prev.greetedAt,
                greetStatus: prev.greetStatus
              }
            : {})
        });
      }
      const all = [...map.values()].sort((a, b) => (b.score || 0) - (a.score || 0));
      await saveResultList(all);
      return {
        batch: rows,
        all,
        recommendCount: all.filter((r) => r.recommend).length
      };
    }

    case 'MAP_FILTERS': {
      const settings = await getSettings();
      const text = payload?.criteriaText || settings.criteriaText;
      if (!text?.trim()) throw new Error('请先填写投递条件描述');
      return mapSearchFilters(settings, text);
    }

    case 'GENERATE_KEYWORDS': {
      const settings = await getSettings();
      const data = await generateSearchKeywords(settings, {
        resumeSummary: settings.resumeSummary,
        resumeText: payload?.resumeText || settings.resumeText,
        criteriaText: payload?.criteriaText || settings.criteriaText
      });
      await saveSettings({ searchKeywords: data.keywords.join('\n') });
      return data;
    }

    case 'GET_MATCH_RECORDS':
      return getMatchRecordsWithGreet();

    case 'CLEAR_MATCH_RECORDS':
      await clearMatchRecords();
      return true;

    case 'GET_RESULT_LIST':
      return getResultList();

    case 'SAVE_RESULT_LIST':
      return saveResultList(payload?.list || []);

    case 'CLEAR_RESULT_LIST':
      await clearResultList();
      return true;

    case 'OPEN_HISTORY': {
      const tab = payload?.tab === 'deliver' ? 'deliver' : 'match';
      const url = chrome.runtime.getURL(`history/history.html?tab=${tab}`);
      await chrome.tabs.create({ url });
      return true;
    }

    case 'MARK_GREETED': {
      const list = await markResultGreeted(payload || {});
      if (payload?.countSuccess) {
        await recordGreetSuccess(1);
      }
      return list;
    }

    case 'GET_RECORD_BY_JOB': {
      const list = await getMatchRecords();
      return list.find((r) => r.jobId === payload?.jobId) || null;
    }

    case 'GREET_JOB_IN_TAB': {
      const url = payload?.url;
      if (!url) throw new Error('缺少职位链接');
      return greetJobInTempTab(url);
    }

    default:
      throw new Error(`未知消息类型: ${type}`);
  }
}

function waitTabComplete(tabId, timeout = 25000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error('打开职位页超时'));
    }, timeout);

    function onUpdated(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    });
  });
}

function sleepBg(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function greetJobInTempTab(url) {
  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id;
    await waitTabComplete(tabId);
    await sleepBg(1500);

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const textOf = (el) => (el?.innerText || el?.textContent || '').trim();
        const btn =
          document.querySelector('.job-detail-container .op-btn-chat') ||
          document.querySelector('.op-btn.op-btn-chat') ||
          document.querySelector('a.op-btn-chat') ||
          document.querySelector('.btn-startchat') ||
          document.querySelector('a.start-chat-btn') ||
          Array.from(document.querySelectorAll('a, button')).find((el) =>
            /立即沟通|沟通/.test(textOf(el))
          );
        if (!btn) return { ok: false, reason: '未找到立即沟通按钮' };
        const t = textOf(btn);
        if (t.includes('继续沟通')) return { ok: false, skipped: true, reason: '已沟通过' };
        if (!/立即沟通|沟通/.test(t) && !btn.className.toString().includes('chat')) {
          return { ok: false, reason: `按钮文案异常: ${t}` };
        }
        btn.click();
        return { ok: true, text: t };
      }
    });

    await sleepBg(1200);
    return result || { ok: false, reason: '脚本无返回' };
  } finally {
    if (tabId != null) {
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        // ignore
      }
    }
  }
}

function ensureResume(settings) {
  if (!settings.resumeText?.trim() && !settings.resumeSummary?.trim()) {
    throw new Error('请先在插件弹窗中配置简历');
  }
}

function parseExcludes(settings) {
  return String(settings.excludeKeywords || '')
    .split(/[,，\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function hitExclude(job, excludes) {
  const hay = `${job.title}\n${job.company}\n${job.description || ''}\n${(job.tags || []).join(',')}`;
  return excludes.find((k) => k && hay.includes(k)) || null;
}

async function matchSingle(settings, job, pageUrl) {
  const excludes = parseExcludes(settings);
  const hit = hitExclude(job, excludes);
  if (hit) {
    const result = {
      score: 15,
      recommend: false,
      reason: `命中排除关键词「${hit}」`,
      pros: [],
      cons: [`包含排除词: ${hit}`],
      missing: []
    };
    await upsertMatchRecord(buildRecord(job, result, pageUrl));
    return result;
  }
  const result = await matchJob(settings, {
    resumeSummary: settings.resumeSummary,
    resumeText: settings.resumeText,
    criteriaText: settings.criteriaText,
    job
  });
  const threshold = Number(settings.matchThreshold) || 70;
  result.recommend = result.score >= threshold && result.recommend !== false;
  if (result.score < threshold) result.recommend = false;
  await upsertMatchRecord(buildRecord(job, result, pageUrl));
  return result;
}

function buildRecord(job, result, pageUrl) {
  return {
    jobId: job.jobId || '',
    title: job.title || '',
    company: job.company || '',
    salary: job.salary || '',
    location: job.location || '',
    url: job.url || pageUrl || '',
    score: result.score,
    recommend: result.recommend,
    reason: result.reason,
    pros: result.pros,
    cons: result.cons,
    missing: result.missing
  };
}
