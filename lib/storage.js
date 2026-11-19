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
  greetBurstEvery: 0,
  greetBurstPauseSec: 0
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
  // 分数已落库：阈值变化只重算 suggest，不必再跑采集匹配
  if (Number(current.matchThreshold) !== Number(next.matchThreshold)) {
    await reapplyRecommendByThreshold(next.matchThreshold);
  }
  return next;
}

/** 用当前阈值从已有分数重算「建议投」 */
export function applyThresholdToList(list, threshold) {
  const t = Number(threshold) || 70;
  return (Array.isArray(list) ? list : []).map((r) => ({
    ...r,
    recommend: Number(r?.score) >= t
  }));
}

/** 阈值变更后：同步结果池 + 匹配记录里的 recommend */
export async function reapplyRecommendByThreshold(threshold) {
  const t = Number(threshold) || 70;
  const records = applyThresholdToList(await getMatchRecords(), t);
  await chrome.storage.local.set({ matchRecords: records });
  return syncResultListFromMatches();
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
  await chrome.storage.local.set({ matchRecords: list });
  return list[idx >= 0 ? idx : 0];
}

export async function clearMatchRecords() {
  await chrome.storage.local.set({ matchRecords: [] });
}

/** 批量写入匹配记录（一轮采集只落盘一次；按 jobId 去重，已有则更新） */
export async function upsertMatchRecordsBatch(records) {
  const list = await getMatchRecords();
  const before = list.length;
  const index = new Map();
  for (let i = 0; i < list.length; i++) {
    index.set(resultKey(list[i]), i);
  }
  const now = Date.now();
  let added = 0;
  let updated = 0;
  for (const record of records || []) {
    const key = resultKey(record);
    if (!key) continue;
    const row = { ...record, updatedAt: now };
    const idx = index.get(key);
    if (idx != null) {
      const prev = list[idx];
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
      updated += 1;
    } else {
      index.set(key, list.length);
      list.push({ ...row, createdAt: now });
      added += 1;
    }
  }
  // 仅排序方便查看：已招呼优先，再按分数（不截断）
  list.sort((a, b) => {
    const g = Number(Boolean(b.greeted)) - Number(Boolean(a.greeted));
    if (g) return g;
    return (b.score || 0) - (a.score || 0);
  });
  await chrome.storage.local.set({ matchRecords: list });
  const saved = await getMatchRecords();
  if (saved.length !== list.length) {
    throw new Error(
      `匹配库写入异常：应为 ${list.length} 条，读回 ${saved.length} 条（请重新加载扩展并确认已授予 unlimitedStorage）`
    );
  }
  return { list: saved, before, added, updated, total: saved.length };
}

export async function getResultList() {
  const data = await chrome.storage.local.get('resultList');
  return Array.isArray(data.resultList) ? data.resultList : [];
}

export async function saveResultList(list) {
  const rows = Array.isArray(list) ? list : [];
  await chrome.storage.local.set({ resultList: rows, resultListAt: Date.now() });
  return rows;
}

/**
 * 面板统计唯一口径：读匹配库（含已招呼合并 + 当前阈值）
 * 库里 / 建议投 / 已投 / 待招呼
 */
export async function getPoolStats() {
  const records = await getMatchRecordsWithGreet();
  const library = records.length;
  const recommend = records.filter((r) => r.recommend).length;
  const greeted = records.filter((r) => r.greeted).length;
  const pending = records.filter((r) => r.recommend && !r.greeted).length;
  return { library, recommend, greeted, pending, records };
}

/** 用匹配库重建结果池，保证打招呼队列与「库里/建议投」同一数据源 */
export async function syncResultListFromMatches() {
  const records = await getMatchRecordsWithGreet();
  const sorted = [...records].sort((a, b) => (b.score || 0) - (a.score || 0));
  return saveResultList(sorted);
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
  await chrome.storage.local.set({ matchRecords: nextRecords });

  return next;
}

/** 匹配记录合并结果列表里的已招呼状态（兼容旧数据） */
export async function getMatchRecordsWithGreet() {
  const [records, results, settings] = await Promise.all([
    getMatchRecords(),
    getResultList(),
    getSettings()
  ]);
  const greetMap = new Map();
  for (const r of results) {
    if (!r?.greeted) continue;
    greetMap.set(resultKey(r), {
      greeted: true,
      greetedAt: r.greetedAt,
      greetStatus: r.greetStatus
    });
  }
  const merged = records.map((r) => {
    if (r.greeted) return r;
    const g = greetMap.get(resultKey(r));
    return g ? { ...r, ...g } : r;
  });
  return applyThresholdToList(merged, settings.matchThreshold);
}

export { DEFAULT_SETTINGS };
