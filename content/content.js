(() => {
  if (window.__BMH_LOADED__) return;
  window.__BMH_LOADED__ = true;

  const state = {
    running: false,
    stop: false,
    results: [],
    greeting: false
  };

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function rand(min, max) {
    return Math.floor(min + Math.random() * (max - min));
  }

  function friendlyError(err) {
    const msg = err?.message || String(err || '');
    if (/Extension context invalidated|sendMessage|asynchronous response/i.test(msg)) {
      return '扩展已更新，请刷新当前 Boss 页面后再试。';
    }
    return msg;
  }

  function extensionAlive() {
    try {
      return Boolean(chrome?.runtime?.id && chrome.runtime.sendMessage);
    } catch {
      return false;
    }
  }

  function openHistory(tab = 'match') {
    void send('OPEN_HISTORY', { tab }).catch(() => {
      try {
        window.open(
          chrome.runtime.getURL(`history/history.html?tab=${tab === 'deliver' ? 'deliver' : 'match'}`),
          '_blank'
        );
      } catch {
        // ignore
      }
    });
  }

  function send(type, payload) {
    return new Promise((resolve, reject) => {
      if (!extensionAlive()) {
        reject(new Error('扩展连接已断开，请刷新 Boss 页面。'));
        return;
      }
      try {
        chrome.runtime.sendMessage({ type, payload }, (res) => {
          if (chrome.runtime?.lastError) {
            reject(new Error(friendlyError(chrome.runtime.lastError)));
            return;
          }
          if (!res?.ok) {
            reject(new Error(res?.error || '请求失败'));
            return;
          }
          resolve(res.data);
        });
      } catch (err) {
        reject(new Error(friendlyError(err)));
      }
    });
  }

  function textOf(el) {
    return (el?.innerText || el?.textContent || '').replace(/\s+\n/g, '\n').trim();
  }

  /** Boss 薪资用 PUA 字符 + 自定义字体伪装数字，需还原为 0-9 */
  function decodeBossDigits(text) {
    return String(text || '').replace(/[\uE031-\uE03A]/g, (ch) =>
      String(ch.charCodeAt(0) - 0xe031)
    );
  }

  function getJobCards() {
    return Array.from(
      document.querySelectorAll('li.job-card-box, li.job-card-wrapper, .job-list-box li')
    ).filter((li) => li.querySelector('a.job-name, .job-name, a[href*="job_detail"]'));
  }

  function isDetailPanel(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    if (el.closest?.('.job-detail-container, .job-detail')) return true;
    const cls = `${el.className || ''}`;
    return /job-detail|detail-container/i.test(cls);
  }

  /**
   * Boss 真实结构（CDP 已确认）：
   * - 左侧 .job-list-container / .rec-job-list：overflow 多为 visible，高度随内容变长
   * - 右侧 .job-detail-container：position sticky + overflow auto（独立滚动）
   * 所以「翻左侧列表」= 滚整页 / scrollIntoView 左侧卡片，绝不能滚右侧详情。
   */
  function findJobListScroller() {
    // 明确禁止右侧
    // 若左侧存在独立 overflow 容器再用；否则返回 null，改走页面滚动
    const cards = getJobCards();
    if (!cards.length) return null;

    let el = cards[0].parentElement;
    while (el && el !== document.body && el !== document.documentElement) {
      if (isDetailPanel(el)) {
        el = el.parentElement;
        continue;
      }
      const st = getComputedStyle(el);
      const oy = st.overflowY;
      const rect = el.getBoundingClientRect();
      const canScroll =
        /(auto|scroll|overlay)/.test(oy) && el.scrollHeight > el.clientHeight + 20;
      const isLeft =
        rect.left < window.innerWidth * 0.5 &&
        rect.width < window.innerWidth * 0.55 &&
        el.querySelectorAll('li.job-card-box, li.job-card-wrapper').length >= 2;
      if (canScroll && isLeft && !isDetailPanel(el)) return el;
      el = el.parentElement;
    }
    return null; // 用页面滚动带动左侧
  }

  function getPageScroller() {
    const se = document.scrollingElement || document.documentElement;
    return se;
  }

  async function scrollJobListOnce(_ignored) {
    // 永远不滚右侧详情
    const detail = document.querySelector('.job-detail-container');
    const cards = getJobCards();
    if (!cards.length) return;

    const leftScroller = findJobListScroller();
    if (leftScroller) {
      const before = leftScroller.scrollTop;
      const step = Math.max(140, Math.floor(leftScroller.clientHeight * 0.4));
      const target = Math.min(leftScroller.scrollHeight, before + step);
      try {
        leftScroller.scrollTo({ top: target, behavior: 'smooth' });
      } catch {
        leftScroller.scrollTop = target;
      }
      leftScroller.dispatchEvent(
        new WheelEvent('wheel', { deltaY: step, bubbles: true, cancelable: true })
      );
      await sleep(rand(800, 1300));
      return;
    }

    // 主流布局：滚页面，让左侧卡片进入视口（右侧 sticky 自己停住）
    const vh = window.innerHeight || 800;
    // 找视口下方第一张左侧卡
    let targetCard = null;
    for (const c of cards) {
      if (isDetailPanel(c)) continue;
      const r = c.getBoundingClientRect();
      if (r.top > vh * 0.55) {
        targetCard = c;
        break;
      }
    }
    if (!targetCard) targetCard = cards[cards.length - 1];

    const beforeY = window.scrollY || document.documentElement.scrollTop || 0;
    targetCard.scrollIntoView({ block: 'start', behavior: 'smooth', inline: 'nearest' });
    await sleep(rand(700, 1100));

    // 若几乎没动，再强制 window 下滚一段
    const afterY = window.scrollY || document.documentElement.scrollTop || 0;
    if (Math.abs(afterY - beforeY) < 30) {
      const page = getPageScroller();
      const step = Math.floor(vh * 0.42);
      try {
        page.scrollBy({ top: step, behavior: 'smooth' });
      } catch {
        window.scrollBy(0, step);
      }
      await sleep(rand(800, 1300));
    } else {
      await sleep(rand(500, 900));
    }

    void detail; // 仅用于提醒：禁止滚动该节点
  }

  function jobIdFromCard(card) {
    const href = card.querySelector('a[href*="job_detail"]')?.getAttribute('href') || '';
    const m = href.match(/job_detail\/([^./?#]+)/);
    return m?.[1] || '';
  }

  function scrapeCard(card) {
    const jobId = jobIdFromCard(card);
    const title = textOf(card.querySelector('.job-name'));
    const company = textOf(card.querySelector('.boss-name, .company-name'));
    const location = textOf(card.querySelector('.company-location, .job-area'));
    const salary = decodeBossDigits(textOf(card.querySelector('.job-salary, .salary')));
    const tags = Array.from(card.querySelectorAll('.tag-list li'))
      .map((n) => textOf(n))
      .filter(Boolean)
      .slice(0, 10);
    return {
      jobId,
      title,
      company,
      location,
      salary,
      tags,
      description: tags.join(' / '),
      url: jobId ? `https://www.zhipin.com/job_detail/${jobId}.html` : '',
      pageUrl: location.href
    };
  }

  function cardKey(card) {
    const id = jobIdFromCard(card);
    if (id) return id;
    return `${textOf(card.querySelector('.job-name'))}|${textOf(
      card.querySelector('.boss-name, .company-name')
    )}`;
  }

  function listFingerprint() {
    return getJobCards()
      .map((c) => cardKey(c))
      .filter(Boolean)
      .join('||');
  }

  /**
   * 纯滚动加载：连续下滑直到出现新职位，或连续多次不再变化
   */
  async function scrollUntilNewJobs(seen, { maxScrolls = 10, keywordLabel = '', round = 0 } = {}) {
    let stable = 0;
    let gotNew = false;

    for (let i = 1; i <= maxScrolls && !state.stop; i++) {
      const beforeFp = listFingerprint();

      setStatus(
        `「${keywordLabel}」第 ${round} 轮慢速滚动 ${i}/${maxScrolls}（带动左侧列表）…`
      );
      await scrollJobListOnce(null);
      // 滚完后再多等一会，避免刷太快漏加载
      await sleep(rand(900, 1600));

      let addedNow = 0;
      for (const card of getJobCards()) {
        const job = scrapeCard(card);
        const key = job.jobId || `${job.title}|${job.company}`;
        if (!key || seen.has(key) || !job.title) continue;
        addedNow += 1;
      }

      const afterFp = listFingerprint();
      setStatus(
        `「${keywordLabel}」第 ${round} 轮 ${i}/${maxScrolls}：DOM ${getJobCards().length} 张，新卡约 ${addedNow}`
      );

      if (addedNow > 0 || afterFp !== beforeFp) {
        gotNew = true;
        stable = 0;
        // 本轮已刷出新内容，稍停再交给上层采集
        await sleep(rand(500, 900));
        if (addedNow > 0 && i >= 2) break;
      } else {
        stable += 1;
        // 连续多次无新内容才认为到底，避免偶发加载慢误判
        if (stable >= 4) break;
        await sleep(rand(600, 1000));
      }
    }
    return gotNew;
  }

  function ensureUI() {
    if (document.getElementById('bmh-root')) return;
    const root = document.createElement('div');
    root.id = 'bmh-root';
    root.innerHTML = `
      <div id="bmh-panel">
        <h3>Boss Match</h3>
        <div class="bmh-row">
          <label>每词滚动轮次 <input id="bmh-pages" type="number" min="1" max="30" value="10" /></label>
        </div>
        <p class="bmh-hint">只滚动列表加载更多，不点页码；每轮把新刷出的职位采进去</p>
        <label class="bmh-check">
          <input id="bmh-do-filter" type="checkbox" />
          开始前先按投递条件筛选
        </label>
        <label class="bmh-label">搜索关键词（轮换，逗号/换行）</label>
        <textarea id="bmh-keywords" rows="2" placeholder="可留空，将按简历自动生成"></textarea>
        <div class="bmh-actions">
          <button id="bmh-gen-kw" class="bmh-secondary" type="button">按简历生成词</button>
          <button id="bmh-filter" class="bmh-secondary" type="button">只筛选</button>
        </div>
        <div class="bmh-actions">
          <button id="bmh-run" class="bmh-primary" type="button">采集并匹配</button>
        </div>
        <div class="bmh-row">
          <label>每日招呼上限 <input id="bmh-greet-limit" type="number" min="1" max="80" value="25" /></label>
        </div>
        <div class="bmh-row">
          <label>间隔秒 min <input id="bmh-greet-min" type="number" min="1" max="300" value="5" /></label>
          <label>max <input id="bmh-greet-max" type="number" min="1" max="600" value="10" /></label>
        </div>
        <p class="bmh-hint">打招呼会限速：随机间隔 + 每 5 次长休息，遇验证码自动停</p>
        <div class="bmh-actions">
          <button id="bmh-greet" class="bmh-primary" type="button" disabled>自动打招呼</button>
          <button id="bmh-stop" class="bmh-secondary bmh-danger" type="button" disabled>停止</button>
        </div>
        <div id="bmh-status">流程：筛选 → 翻页抓列表 → 批量打分 → 自动打招呼</div>
        <div id="bmh-summary" class="bmh-list-summary"></div>
        <div class="bmh-nav">
          <button type="button" class="bmh-linkish" data-history-tab="match">匹配记录</button>
          <span class="bmh-nav-sep">·</span>
          <button type="button" class="bmh-linkish" data-history-tab="deliver">投递结果</button>
        </div>
        <div id="bmh-tip">详细列表请点上方链接查看；打招呼请控制量。</div>
      </div>
      <button id="bmh-toggle" type="button">Boss Match</button>
    `;
    document.documentElement.appendChild(root);
    root.classList.add('open');

    root.querySelector('#bmh-toggle').addEventListener('click', () => {
      root.classList.toggle('open');
    });
    root.querySelectorAll('[data-history-tab]').forEach((btn) => {
      btn.addEventListener('click', () => openHistory(btn.dataset.historyTab));
    });
    root.querySelector('#bmh-filter').addEventListener('click', () => onlyFilter());
    root.querySelector('#bmh-gen-kw').addEventListener('click', () => genKeywordsFromResume());
    root.querySelector('#bmh-run').addEventListener('click', () => runCollectAndMatch());
    root.querySelector('#bmh-greet').addEventListener('click', () => runAutoGreet());
    root.querySelector('#bmh-stop').addEventListener('click', () => {
      state.stop = true;
      setStatus('正在停止…');
    });

    for (const id of [
      'bmh-pages',
      'bmh-do-filter',
      'bmh-keywords',
      'bmh-greet-limit',
      'bmh-greet-min',
      'bmh-greet-max'
    ]) {
      const el = root.querySelector(`#${id}`);
      el?.addEventListener('change', () => savePanelOptions());
      if (id !== 'bmh-do-filter') {
        el?.addEventListener('input', () => scheduleSavePanelOptions());
      }
    }

    restorePanelAndResults();
  }

  function parseKeywordList(text) {
    return String(text || '')
      .split(/[,，\n、;；]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  let panelSaveTimer = null;
  function scheduleSavePanelOptions() {
    clearTimeout(panelSaveTimer);
    panelSaveTimer = setTimeout(() => savePanelOptions(), 300);
  }

  function readPanelOptions() {
    let minSec = Math.max(1, Number(document.getElementById('bmh-greet-min')?.value) || 5);
    let maxSec = Math.max(1, Number(document.getElementById('bmh-greet-max')?.value) || 10);
    if (maxSec < minSec) maxSec = minSec + 20;
    return {
      panelPages: Math.min(30, Math.max(1, Number(document.getElementById('bmh-pages')?.value) || 10)),
      panelDoFilter: Boolean(document.getElementById('bmh-do-filter')?.checked),
      searchKeywords: document.getElementById('bmh-keywords')?.value || '',
      greetDailyLimit: Math.min(80, Math.max(1, Number(document.getElementById('bmh-greet-limit')?.value) || 25)),
      greetIntervalMinSec: minSec,
      greetIntervalMaxSec: maxSec
    };
  }

  async function savePanelOptions() {
    try {
      const opts = readPanelOptions();
      await send('SAVE_PANEL_OPTIONS', opts);
    } catch {
      // ignore
    }
  }

  async function restorePanelAndResults() {
    try {
      const settings = await send('GET_SETTINGS');
      const pages = document.getElementById('bmh-pages');
      const doFilter = document.getElementById('bmh-do-filter');
      const kw = document.getElementById('bmh-keywords');
      const greetLimit = document.getElementById('bmh-greet-limit');
      const greetMin = document.getElementById('bmh-greet-min');
      const greetMax = document.getElementById('bmh-greet-max');
      // 旧默认是 3，容易误以为只翻两三页；自动升到 10（可再改）
      let savedPages = Number(settings.panelPages ?? 10);
      if (savedPages <= 3) savedPages = 10;
      if (pages) pages.value = String(savedPages);
      if (doFilter) doFilter.checked = settings.panelDoFilter !== false;
      if (kw) kw.value = settings.searchKeywords || '';
      if (greetLimit) greetLimit.value = String(settings.greetDailyLimit ?? 25);
      if (greetMin) greetMin.value = String(settings.greetIntervalMinSec ?? 5);
      if (greetMax) greetMax.value = String(settings.greetIntervalMaxSec ?? 10);
      if (Number(settings.panelPages ?? 0) <= 3) {
        void savePanelOptions();
      }

      const list = await send('GET_RESULT_LIST');
      renderList(list);
      let quotaTip = '';
      try {
        const q = await send('GET_GREET_QUOTA');
        quotaTip = `｜今日已招呼 ${q.used}/${q.limit}`;
      } catch {
        // ignore
      }
      if (list?.length) {
        setStatus(
          `已恢复上次结果 ${list.length} 条（建议投 ${list.filter((r) => r.recommend).length}）${quotaTip}`
        );
      } else {
        setStatus(`可填多个关键词轮换搜索；筛选 → 滚动采集 → 批量打分${quotaTip}`);
      }
    } catch (err) {
      setStatus(friendlyError(err));
    }
  }

  async function resolveKeywords(mappedFilters) {
    const fromPanel = parseKeywordList(document.getElementById('bmh-keywords')?.value);
    if (fromPanel.length) return fromPanel;

    const settings = await send('GET_SETTINGS');
    const fromSettings = parseKeywordList(settings.searchKeywords);
    if (fromSettings.length) return fromSettings;

    // 优先按简历自动生成
    if (settings.resumeText?.trim() || settings.resumeSummary?.trim()) {
      setStatus('关键词为空，正在根据简历自动生成…');
      try {
        const data = await send('GENERATE_KEYWORDS', {});
        const kw = document.getElementById('bmh-keywords');
        if (kw) kw.value = data.keywords.join('\n');
        await savePanelOptions();
        return data.keywords;
      } catch (err) {
        setStatus(`简历生成关键词失败，尝试用条件映射：${err.message || err}`);
      }
    }

    const fromMap = [];
    if (Array.isArray(mappedFilters?.queries)) {
      fromMap.push(...mappedFilters.queries.map((s) => String(s).trim()).filter(Boolean));
    }
    if (mappedFilters?.query) fromMap.push(String(mappedFilters.query).trim());
    const uniq = [...new Set(fromMap.filter(Boolean))];
    if (uniq.length) {
      const kw = document.getElementById('bmh-keywords');
      if (kw && !kw.value.trim()) kw.value = uniq.join('\n');
      await savePanelOptions();
      return uniq;
    }
    return [];
  }

  function setStatus(msg) {
    const el = document.getElementById('bmh-status');
    if (el) el.textContent = msg;
  }

  function setBusy(busy) {
    state.running = busy;
    const ids = ['bmh-run', 'bmh-filter', 'bmh-greet', 'bmh-gen-kw'];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (!el) continue;
      if (id === 'bmh-greet') {
        el.disabled =
          busy || !state.results.some((r) => r.recommend && !r.greeted);
      } else {
        el.disabled = busy;
      }
    }
    const stop = document.getElementById('bmh-stop');
    if (stop) stop.disabled = !busy;
  }

  async function genKeywordsFromResume() {
    if (state.running) return;
    setBusy(true);
    try {
      setStatus('正在根据简历生成搜索关键词…');
      const data = await send('GENERATE_KEYWORDS', {});
      const kw = document.getElementById('bmh-keywords');
      if (kw) kw.value = data.keywords.join('\n');
      await savePanelOptions();
      setStatus(`已生成：${data.keywords.join('、')}${data.reason ? `\n${data.reason}` : ''}`);
    } catch (err) {
      setStatus(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  function renderList(list) {
    state.results = list || [];
    const summary = document.getElementById('bmh-summary');
    const rec = state.results.filter((r) => r.recommend).length;
    const greeted = state.results.filter((r) => r.greeted).length;
    const pending = state.results.filter((r) => r.recommend && !r.greeted).length;

    if (summary) {
      summary.textContent = state.results.length
        ? `待招呼 ${pending} · 已招呼 ${greeted} · 建议投 ${rec}`
        : '暂无结果，先「采集并匹配」';
    }

    const greet = document.getElementById('bmh-greet');
    if (greet && !state.running) greet.disabled = pending === 0;
    setStatus(
      `结果 ${state.results.length} 条｜建议投 ${rec}｜已招呼 ${greeted}｜待招呼 ${pending}`
    );
  }

  async function markGreeted(item, greetStatus = 'ok', countSuccess = true) {
    const list = await send('MARK_GREETED', {
      jobId: item.jobId || '',
      title: item.title || '',
      company: item.company || '',
      salary: decodeBossDigits(item.salary || ''),
      location: item.location || '',
      url: item.url || '',
      score: item.score,
      recommend: item.recommend,
      reason: item.reason,
      greetStatus,
      countSuccess
    });
    renderList(list);
    return list;
  }

  function detectRiskPage() {
    const t = document.body?.innerText || '';
    return /验证码|人机验证|操作过于频繁|账号存在风险|请稍后重试|访问行为异常/.test(t);
  }

  async function waitCountdown(totalSec, label) {
    const end = Date.now() + totalSec * 1000;
    while (!state.stop && Date.now() < end) {
      const left = Math.ceil((end - Date.now()) / 1000);
      setStatus(`${label}（还需 ${left}s，可点停止）`);
      await sleep(Math.min(1000, end - Date.now()));
    }
  }

  function findCardForItem(item) {
    if (item?.jobId) {
      const byId = getJobCards().find((c) => jobIdFromCard(c) === item.jobId);
      if (byId) return byId;
    }
    if (item?.title) {
      return getJobCards().find((c) => textOf(c.querySelector('.job-name')).includes(item.title));
    }
    return null;
  }

  /** 仅用于人工点结果查看：优先当前列表，找不到才新开（不自动关） */
  async function focusJob(item) {
    setStatus(`定位：${item.title || item.jobId}`);
    const card = findCardForItem(item);
    if (card) {
      card.scrollIntoView({ block: 'center', behavior: 'smooth' });
      (card.querySelector('a.job-name, .job-name') || card).click();
      return { mode: 'list' };
    }
    if (item.url) {
      window.open(item.url, '_blank');
      return { mode: 'tab' };
    }
    setStatus('当前列表找不到该职位');
    return { mode: 'none' };
  }

  async function waitDetailChatButton(timeout = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const btn =
        document.querySelector('.job-detail-container .op-btn-chat') ||
        document.querySelector('.job-detail-container a.op-btn-chat') ||
        document.querySelector('.op-btn.op-btn-chat');
      if (btn && btn.offsetParent !== null) return btn;
      await sleep(300);
    }
    return null;
  }

  async function applyFilter({ resumeAfter = false } = {}) {
    if (!window.BMHFilters?.applyFilters) {
      throw new Error('筛选模块未加载，请刷新扩展和页面');
    }
    setStatus('映射投递条件…');
    const filters = await send('MAP_FILTERS', {});
    setStatus(`筛选：${JSON.stringify(filters)}`);
    const result = await window.BMHFilters.applyFilters(filters, { preferUrl: true });
    if (result.navigated) {
      if (resumeAfter) {
        sessionStorage.setItem('bmh_pending_run', JSON.stringify({ at: Date.now() }));
      }
      setStatus(`已跳转筛选页：${result.url}`);
      return result;
    }
    setStatus((result.logs || []).join('\n'));
    return result;
  }

  async function onlyFilter() {
    if (state.running) return;
    setBusy(true);
    state.stop = false;
    try {
      await applyFilter({ resumeAfter: false });
    } catch (err) {
      setStatus(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  function ingestCards(cards, all, seen) {
    let added = 0;
    for (const card of cards) {
      const job = scrapeCard(card);
      const key = job.jobId || `${job.title}|${job.company}`;
      if (!key || seen.has(key) || !job.title) continue;
      seen.add(key);
      all.push(job);
      added += 1;
    }
    return added;
  }

  async function collectJobsForCurrentKeyword({ maxPages, all, seen, keywordLabel }) {
    let keywordAdded = 0;
    const rounds = maxPages;

    // 新关键词：页面滚回顶部（带动左侧列表），禁止动右侧详情
    window.scrollTo({ top: 0, behavior: 'smooth' });
    const leftScroller = findJobListScroller();
    if (leftScroller) leftScroller.scrollTop = 0;
    setStatus(
      leftScroller
        ? `「${keywordLabel}」使用左侧独立滚动容器`
        : `「${keywordLabel}」左侧无独立滚动（Boss 常态），改为滚页面带动左侧列表，不滚右侧详情`
    );
    await sleep(rand(900, 1400));

    setStatus(`开始采集「${keywordLabel}」，慢速滚 ${rounds} 轮`);

    // 先采首屏
    {
      const before = all.length;
      ingestCards(getJobCards(), all, seen);
      keywordAdded += all.length - before;
      setStatus(`「${keywordLabel}」首屏 +${all.length - before}｜本词 ${keywordAdded}`);
    }

    for (let round = 1; round <= rounds; round++) {
      if (state.stop) break;

      setStatus(`「${keywordLabel}」滚动第 ${round}/${rounds} 轮…（本词 ${keywordAdded}）`);
      const before = all.length;
      const beforeSize = seen.size;

      const gotNew = await scrollUntilNewJobs(seen, {
        maxScrolls: 8,
        keywordLabel,
        round
      });
      if (state.stop) break;

      ingestCards(getJobCards(), all, seen);
      const added = all.length - before;
      keywordAdded += added;
      setStatus(
        `「${keywordLabel}」第 ${round}/${rounds} 轮：+${added}｜本词 ${keywordAdded}｜总计 ${all.length}`
      );

      // 连续滚不出新职位就结束本词
      if (!gotNew && added === 0 && seen.size === beforeSize) {
        setStatus(
          `「${keywordLabel}」已滚到底，提前结束（完成 ${round}/${rounds} 轮，本词 ${keywordAdded} 条）`
        );
        break;
      }

      // 轮次之间再歇一会
      await sleep(rand(800, 1400));
    }

    setStatus(`关键词「${keywordLabel}」结束：本词 ${keywordAdded} 条，总计 ${all.length}`);
  }

  async function runCollectAndMatch() {
    if (state.running) return;
    if (!extensionAlive()) {
      setStatus('扩展连接已断开，请刷新 Boss 页面。');
      return;
    }
    setBusy(true);
    state.stop = false;
    try {
      await savePanelOptions();
      const opts = readPanelOptions();
      let mapped = null;

      const doFilter = Boolean(document.getElementById('bmh-do-filter')?.checked);
      if (doFilter) {
        setStatus('映射投递条件…');
        mapped = await send('MAP_FILTERS', {});
        const applied = await window.BMHFilters.applyFilters(mapped, { preferUrl: true });
        if (applied?.navigated) {
          sessionStorage.setItem(
            'bmh_pending_run',
            JSON.stringify({ at: Date.now(), mapped })
          );
          setStatus(`已跳转筛选页，加载后继续…`);
          return;
        }
        await sleep(800);
      } else {
        try {
          mapped = await send('MAP_FILTERS', {});
        } catch {
          mapped = null;
        }
      }

      let keywords = await resolveKeywords(mapped);
      if (!keywords.length) {
        // 没有关键词就用当前页直接采
        keywords = ['(当前搜索)'];
      }

      const all = [];
      const seen = new Set();

      for (let i = 0; i < keywords.length; i++) {
        if (state.stop) break;
        const kw = keywords[i];
        const isPlaceholder = kw === '(当前搜索)';

        if (!isPlaceholder) {
          setStatus(`切换关键词 ${i + 1}/${keywords.length}：${kw}`);
          if (!window.BMHFilters?.switchKeyword) {
            throw new Error('筛选模块未加载');
          }
          const sw = await window.BMHFilters.switchKeyword(kw);
          if (sw.navigated) {
            sessionStorage.setItem(
              'bmh_pending_run',
              JSON.stringify({
                at: Date.now(),
                mapped,
                keywordIndex: i,
                keywords,
                // 已采集的先匹配掉也行；这里用 storage 不够方便，重新从该词开始
              })
            );
            setStatus(`关键词跳转中：${kw}`);
            return;
          }
          if (!sw.ok) {
            setStatus(`关键词「${kw}」切换失败：${sw.reason || ''}，跳过`);
            continue;
          }
          await sleep(rand(1500, 2500));
        }

        await collectJobsForCurrentKeyword({
          maxPages: opts.panelPages,
          all,
          seen,
          keywordLabel: kw
        });
      }

      if (state.stop) {
        setStatus(`已停止，已采集 ${all.length} 条`);
        return;
      }
      if (!all.length) {
        setStatus('没采集到职位，请确认在职位列表页且已登录');
        return;
      }

      setStatus(`采集 ${all.length} 条（${keywords.length} 个关键词），批量匹配中…`);
      const data = await send('MATCH_JOBS_BATCH', { jobs: all, pageUrl: location.href });
      renderList(data.all || data.batch || []);
      setStatus(
        `完成：本批 ${data.batch?.length || 0}，结果池 ${data.all?.length || 0}，建议投 ${data.recommendCount || 0}`
      );
    } catch (err) {
      setStatus(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  async function clickChatOnCurrent() {
    const btn = await waitDetailChatButton(5000);
    if (!btn) return { ok: false, reason: '未找到右侧「立即沟通」' };
    const t = textOf(btn);
    if (t.includes('继续沟通')) return { ok: false, reason: '已沟通过', skipped: true };
    btn.click();
    await sleep(rand(900, 1500));
    return { ok: true, text: t };
  }

  /** 当前列表有卡：点左侧 → 点右侧立即沟通；否则后台开临时标签沟通后自动关掉 */
  async function greetOne(item) {
    const card = findCardForItem(item);
    if (card) {
      card.scrollIntoView({ block: 'center', behavior: 'smooth' });
      await sleep(rand(400, 700));
      (card.querySelector('a.job-name, .job-name') || card).click();
      await sleep(rand(800, 1400));
      return clickChatOnCurrent();
    }

    const url =
      item.url ||
      (item.jobId ? `https://www.zhipin.com/job_detail/${item.jobId}.html` : '');
    if (!url) return { ok: false, reason: '无职位链接且当前列表找不到' };

    setStatus(`临时打开详情页沟通后关闭：${item.title || item.jobId}`);
    return send('GREET_JOB_IN_TAB', { url });
  }

  async function runAutoGreet() {
    if (state.running) return;
    await savePanelOptions();
    const quota = await send('GET_GREET_QUOTA');
    const pendingAll = state.results.filter((r) => r.recommend && !r.greeted);
    if (!pendingAll.length) {
      setStatus('没有待招呼的「建议投」职位（未招呼过的）');
      return;
    }
    if (quota.remain <= 0) {
      setStatus(`今日招呼已达上限 ${quota.limit}，明天再继续`);
      return;
    }

    const targets = pendingAll.slice(0, quota.remain);
    const minSec = Math.min(quota.intervalMinSec, quota.intervalMaxSec);
    const maxSec = Math.max(quota.intervalMinSec, quota.intervalMaxSec);
    if (
      !confirm(
        `将对 ${targets.length} 个未招呼的「建议投」自动沟通（今日剩余额度 ${quota.remain}/${quota.limit}）。\n间隔约 ${minSec}-${maxSec} 秒，每 ${quota.burstEvery} 次额外休息约 ${quota.burstPauseSec} 秒。\n成功后会在本地标记「已招呼」。继续？`
      )
    ) {
      return;
    }

    setBusy(true);
    state.stop = false;
    state.greeting = true;
    let ok = 0;
    let skip = 0;
    let fail = 0;
    let successStreak = 0;

    try {
      for (let i = 0; i < targets.length; i++) {
        if (state.stop) break;
        if (detectRiskPage()) {
          setStatus('检测到验证码/风控提示，已自动停止，避免封号');
          break;
        }

        const item = targets[i];
        setStatus(`打招呼 ${i + 1}/${targets.length}：${item.title}（今日已用 ${quota.used + ok}/${quota.limit}）`);
        try {
          const r = await greetOne(item);
          if (r?.ok) {
            ok += 1;
            successStreak += 1;
            await markGreeted(item, 'ok', true);
          } else if (r?.skipped) {
            skip += 1;
            // 已沟通过也标记，避免反复点
            await markGreeted(item, 'already', false);
          } else {
            fail += 1;
            setStatus(
              `失败 ${i + 1}/${targets.length}：${item.title}（${r?.reason || '未知'}）`
            );
            if (fail >= 3) {
              setStatus('连续失败较多，已停止。请检查登录/风控后再继续');
              break;
            }
          }
        } catch (err) {
          fail += 1;
          setStatus(`失败 ${i + 1}/${targets.length}：${friendlyError(err)}`);
          if (fail >= 3) break;
        }

        if (state.stop || i >= targets.length - 1) break;

        // 防封：随机长间隔
        const pauseSec = rand(minSec, maxSec + 1);
        await waitCountdown(pauseSec, `已处理 ${i + 1}/${targets.length}，限速等待`);

        // 每 N 次成功后再多歇一会
        if (successStreak > 0 && successStreak % quota.burstEvery === 0) {
          await waitCountdown(
            quota.burstPauseSec,
            `已连续成功 ${successStreak} 次，额外休息防封`
          );
        }
      }
      const q2 = await send('GET_GREET_QUOTA');
      setStatus(
        `${state.stop ? '已停止' : '打招呼结束'}：成功 ${ok} · 已沟通跳过 ${skip} · 失败 ${fail}｜今日 ${q2.used}/${q2.limit}`
      );
    } catch (err) {
      setStatus(friendlyError(err));
    } finally {
      state.greeting = false;
      setBusy(false);
    }
  }

  function resumePending() {
    try {
      const raw = sessionStorage.getItem('bmh_pending_run');
      if (!raw) return;
      const data = JSON.parse(raw);
      sessionStorage.removeItem('bmh_pending_run');
      if (!data?.at || Date.now() - data.at > 90_000) return;
      setStatus('页面已就绪，2 秒后继续采集匹配…');
      setTimeout(() => {
        const box = document.getElementById('bmh-do-filter');
        if (box) box.checked = false; // 避免再次整页筛选跳转
        // 若是从某个关键词跳转回来，从该词继续
        if (Array.isArray(data.keywords) && data.keywords.length) {
          const kw = document.getElementById('bmh-keywords');
          if (kw) {
            const rest = data.keywords.slice(Number(data.keywordIndex) || 0);
            kw.value = rest.join('\n');
          }
        }
        runCollectAndMatch();
      }, 2000);
    } catch {
      // ignore
    }
  }

  function boot() {
    ensureUI();
    resumePending();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
