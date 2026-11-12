/**
 * Boss 直聘筛选项：条件 JSON → 点选页面 / 跳转 URL
 * 非 module，由 manifest 在 content.js 前注入。
 */
(function (global) {
  const CITY_IDS = {
    北京: '101010100',
    上海: '101020100',
    广州: '101280100',
    深圳: '101280600',
    杭州: '101210100',
    成都: '101270100',
    南京: '101190100',
    武汉: '101200100',
    西安: '101110100',
    苏州: '101190400',
    天津: '101030100',
    重庆: '101040100',
    长沙: '101250100',
    郑州: '101180100',
    东莞: '101281600',
    佛山: '101280800',
    合肥: '101220100',
    青岛: '101120200',
    大连: '101070200',
    厦门: '101230200',
    宁波: '101210400',
    无锡: '101190200',
    福州: '101230100',
    济南: '101120100',
    沈阳: '101070100'
  };

  const LABELS = {
    jobType: {
      0: '不限',
      1901: '全职',
      1903: '兼职'
    },
    salary: {
      0: '不限',
      402: '3K以下',
      403: '3-5K',
      404: '5-10K',
      405: '10-20K',
      406: '20-50K',
      407: '50K以上'
    },
    experience: {
      0: '不限',
      108: '在校生',
      102: '应届生',
      101: '经验不限',
      103: '1年以内',
      104: '1-3年',
      105: '3-5年',
      106: '5-10年',
      107: '10年以上'
    },
    degree: {
      0: '不限',
      209: '初中及以下',
      208: '中专/中技',
      206: '高中',
      202: '大专',
      203: '本科',
      204: '硕士',
      205: '博士'
    },
    scale: {
      0: '不限',
      301: '0-20人',
      302: '20-99人',
      303: '100-499人',
      304: '500-999人',
      305: '1000-9999人',
      306: '10000人以上'
    }
  };

  const FILTER_TITLE = {
    jobType: '求职类型',
    salary: '薪资待遇',
    experience: '工作经验',
    degree: '学历要求',
    scale: '公司规模'
  };

  const KA_KEY = {
    jobType: 'jobType',
    salary: 'salary',
    experience: 'exp',
    degree: 'degree',
    scale: 'scale'
  };

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function textOf(el) {
    return (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function cityIdOf(name) {
    if (!name) return '';
    const n = String(name).trim();
    if (/^\d{9}$/.test(n)) return n;
    if (CITY_IDS[n]) return CITY_IDS[n];
    const hit = Object.keys(CITY_IDS).find((k) => n.includes(k) || k.includes(n));
    return hit ? CITY_IDS[hit] : '';
  }

  function buildSearchUrl(filters) {
    const params = new URLSearchParams();
    if (filters.query) params.set('query', filters.query);
    const city = cityIdOf(filters.city);
    if (city) params.set('city', city);
    const map = {
      jobType: 'jobType',
      salary: 'salary',
      experience: 'experience',
      degree: 'degree',
      scale: 'scale'
    };
    for (const [k, q] of Object.entries(map)) {
      const v = Number(filters[k] || 0);
      if (v) params.set(q, String(v));
    }
    return `https://www.zhipin.com/web/geek/job?${params.toString()}`;
  }

  function findFilterTrigger(title) {
    const nodes = Array.from(
      document.querySelectorAll(
        '.condition-filter-select, .condition-industry-select, .filter-condition .dropdown-select, .c-filter-condition [class*="select"]'
      )
    );
    return nodes.find((n) => textOf(n).includes(title)) || null;
  }

  function findOption(code, label, kaPart) {
    const lis = Array.from(document.querySelectorAll('.filter-select-dropdown li, .dropdown-menu li, ul li'));
    const byKa = lis.find((li) => {
      const ka = li.getAttribute('ka') || '';
      return kaPart && code && (ka.includes(`${kaPart}-${code}`) || ka.endsWith(`-${code}`));
    });
    if (byKa) return byKa;
    if (!label || label === '不限') {
      return lis.find((li) => textOf(li) === '不限' || textOf(li).startsWith('不限')) || null;
    }
    return (
      lis.find((li) => textOf(li) === label) ||
      lis.find((li) => textOf(li).includes(label)) ||
      null
    );
  }

  async function selectDiscrete(filterKey, code) {
    const n = Number(code || 0);
    if (!n) return { key: filterKey, skipped: true, reason: '不限' };
    const title = FILTER_TITLE[filterKey];
    const label = LABELS[filterKey]?.[n];
    const trigger = findFilterTrigger(title);
    if (!trigger) return { key: filterKey, ok: false, reason: `未找到筛选项「${title}」` };

    trigger.click();
    await sleep(280 + Math.random() * 220);
    const opt = findOption(n, label, KA_KEY[filterKey]);
    if (!opt) {
      document.body.click();
      return { key: filterKey, ok: false, reason: `未找到选项 ${label || n}` };
    }
    opt.click();
    await sleep(350 + Math.random() * 250);
    return { key: filterKey, ok: true, label: label || String(n) };
  }

  async function fillQuery(query) {
    if (!query) return { skipped: true };
    const input =
      document.querySelector('.search-input-box input, .job-search-form input, input[placeholder*="搜索"]') ||
      document.querySelector('input.input');
    if (!input) return { ok: false, reason: '未找到搜索框' };

    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(input, query);
    else input.value = query;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(200);
    return { ok: true, query };
  }

  async function clickSearch() {
    const btn =
      document.querySelector('a.search-btn, button.search-btn, .search-btn') ||
      Array.from(document.querySelectorAll('a, button')).find((el) => textOf(el) === '搜索');
    if (!btn) return false;
    btn.click();
    return true;
  }

  /**
   * 优先用 URL 一次带上 query/city/salary…（更稳）
   * 若已在职位页且 city 不变，也可 DOM 点选。
   */
  async function applyFilters(filters, { preferUrl = true } = {}) {
    const f = filters || {};
    const logs = [];

    if (preferUrl) {
      const url = buildSearchUrl(f);
      const cur = new URL(location.href);
      const next = new URL(url);
      // 同站职位页用 assign，避免丢登录态
      if (!cur.pathname.includes('/web/geek/job') || cur.search !== next.search) {
        logs.push(`跳转筛选：${url}`);
        location.assign(url);
        return { navigated: true, url, logs };
      }
    }

    const q = await fillQuery(f.query);
    logs.push(q.ok ? `关键词：${f.query}` : q.skipped ? '关键词跳过' : `关键词失败：${q.reason}`);

    for (const key of ['jobType', 'salary', 'experience', 'degree', 'scale']) {
      const r = await selectDiscrete(key, f[key]);
      if (r.skipped) logs.push(`${FILTER_TITLE[key]}：不限`);
      else if (r.ok) logs.push(`${FILTER_TITLE[key]}：${r.label}`);
      else logs.push(`${FILTER_TITLE[key]}失败：${r.reason}`);
    }

    await sleep(300);
    const searched = await clickSearch();
    logs.push(searched ? '已点击搜索' : '未找到搜索按钮（筛选项可能已即时生效）');
    await sleep(1200);
    return { navigated: false, logs, filters: f };
  }

  /**
   * 只换搜索关键词并搜索（优先 DOM，避免整页刷新打断采集）
   */
  async function switchKeyword(keyword) {
    const q = String(keyword || '').trim();
    if (!q) return { ok: false, reason: '空关键词' };

    const filled = await fillQuery(q);
    if (filled.ok) {
      await sleep(200);
      const searched = await clickSearch();
      await sleep(1500);
      // 滚回列表顶
      const list =
        document.querySelector('.job-list-container, .search-job-result, [class*="job-list"]') ||
        null;
      if (list) list.scrollTop = 0;
      return { ok: true, navigated: false, query: q, searched: Boolean(searched) };
    }

    // DOM 失败则改 URL query
    try {
      const cur = new URL(location.href);
      cur.searchParams.set('query', q);
      location.assign(cur.toString());
      return { ok: true, navigated: true, url: cur.toString(), query: q };
    } catch (err) {
      return { ok: false, reason: err?.message || '切换关键词失败' };
    }
  }

  global.BMHFilters = {
    CITY_IDS,
    LABELS,
    cityIdOf,
    buildSearchUrl,
    applyFilters,
    switchKeyword,
    fillQuery,
    clickSearch
  };
})(window);
