const DEFAULT_SETTINGS = {
  apiBase: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-flash',
  criteriaText: '',
  matchThreshold: 70,
  resumeText: '',
  resumeName: '',
  resumeSummary: '',
  excludeKeywords: '外包,派遣,驻场',
  // 多个搜索词，逗号/换行分隔，采集时轮换
  searchKeywords: '',
  // 职位页面板选项
  panelPages: 10,
  panelLimit: 15,
  panelDoFilter: true,
  // 打招呼防封
  greetDailyLimit: 25,
  greetIntervalMinSec: 5,
  greetIntervalMaxSec: 10,
  greetBurstEvery: 5,
  greetBurstPauseSec: 180
};

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

export async function getGreetStats() {
  const data = await chrome.storage.local.get(['greetDate', 'greetCount']);
  const today = todayKey();
  if (data.greetDate !== today) {
    return { date: today, count: 0 };
  }
  return { date: today, count: Number(data.greetCount) || 0 };
}

export async function recordGreetSuccess(n = 1) {
  const today = todayKey();
  const cur = await getGreetStats();
  const count = (cur.date === today ? cur.count : 0) + n;
  await chrome.storage.local.set({ greetDate: today, greetCount: count });
  return { date: today, count };
}

export async function getSettings() {
  const data = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
}

export async function saveSettings(partial) {
  const current = await getSettings();
  const next = { ...current, ...partial };
  await chrome.storage.local.set({ settings: next });
  return next;
}

export async function getMatchRecords() {
  const data = await chrome.storage.local.get('matchRecords');
  return Array.isArray(data.matchRecords) ? data.matchRecords : [];
}

export async function upsertMatchRecord(record) {
  const list = await getMatchRecords();
  const idx = list.findIndex((r) => {
    if (record.jobId && r.jobId) return r.jobId === record.jobId;
    return resultKey(r) === resultKey(record);
  });
  const row = {
    ...record,
    updatedAt: Date.now()
  };
  if (idx >= 0) {
    const prev = list[idx];
    // 重新匹配时保留已招呼标记
    list[idx] = {
      ...prev,
      ...row,
      ...(prev.greeted
        ? {
            greeted: prev.greeted,
            greetedAt: prev.greetedAt,
            greetStatus: prev.greetStatus
          }
        : {})
    };
  } else {
    list.unshift({ ...row, createdAt: Date.now() });
  }
  // keep latest 500
  const trimmed = list.slice(0, 500);
  await chrome.storage.local.set({ matchRecords: trimmed });
  return list[idx >= 0 ? idx : 0];
}

export async function clearMatchRecords() {
  await chrome.storage.local.set({ matchRecords: [] });
}

export async function getResultList() {
  const data = await chrome.storage.local.get('resultList');
  return Array.isArray(data.resultList) ? data.resultList : [];
}

export async function saveResultList(list) {
  const rows = Array.isArray(list) ? list.slice(0, 300) : [];
  await chrome.storage.local.set({ resultList: rows, resultListAt: Date.now() });
  return rows;
}

export async function clearResultList() {
  await chrome.storage.local.set({ resultList: [], resultListAt: Date.now() });
}

function resultKey(r) {
  return r?.jobId || `${r?.title || ''}|${r?.company || ''}`;
}

function applyGreeted(list, partial, greetedAt) {
  const key = resultKey(partial);
  let hit = false;
  const next = list.map((r) => {
    if (resultKey(r) !== key) return r;
    hit = true;
    return {
      ...r,
      greeted: true,
      greetedAt,
      greetStatus: partial.greetStatus || 'ok'
    };
  });
  if (!hit && key) {
    next.unshift({
      ...partial,
      greeted: true,
      greetedAt,
      greetStatus: partial.greetStatus || 'ok',
      createdAt: greetedAt,
      updatedAt: greetedAt
    });
  }
  return next;
}

/** 标记已打招呼；同步写入结果列表 + 匹配记录 */
export async function markResultGreeted(partial) {
  const greetedAt = Date.now();
  const list = await getResultList();
  const next = applyGreeted(list, partial, greetedAt);
  await saveResultList(next);

  const records = await getMatchRecords();
  const nextRecords = applyGreeted(records, partial, greetedAt);
  await chrome.storage.local.set({ matchRecords: nextRecords.slice(0, 500) });

  return next;
}

/** 匹配记录合并结果列表里的已招呼状态（兼容旧数据） */
export async function getMatchRecordsWithGreet() {
  const [records, results] = await Promise.all([getMatchRecords(), getResultList()]);
  const greetMap = new Map();
  for (const r of results) {
    if (!r?.greeted) continue;
    greetMap.set(resultKey(r), {
      greeted: true,
      greetedAt: r.greetedAt,
      greetStatus: r.greetStatus
    });
  }
  return records.map((r) => {
    if (r.greeted) return r;
    const g = greetMap.get(resultKey(r));
    return g ? { ...r, ...g } : r;
  });
}

export { DEFAULT_SETTINGS };
