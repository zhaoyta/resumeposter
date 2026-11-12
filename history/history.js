async function send(type, payload) {
  const res = await chrome.runtime.sendMessage({ type, payload });
  if (!res?.ok) throw new Error(res?.error || '请求失败');
  return res.data;
}

function fmtTime(ts) {
  if (!ts) return '-';
  return new Date(ts).toLocaleString();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Boss 薪资 PUA 数字还原（兼容已入库乱码） */
function decodeBossDigits(text) {
  return String(text || '').replace(/[\uE031-\uE03A]/g, (ch) =>
    String(ch.charCodeAt(0) - 0xe031)
  );
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

function linkTitle(r) {
  return r.url
    ? `<a href="${escapeAttr(r.url)}" target="_blank" rel="noreferrer">${escapeHtml(r.title || '-')}</a>`
    : escapeHtml(r.title || '-');
}

let activeTab = 'match';

function setTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab').forEach((el) => {
    const on = el.dataset.tab === tab;
    el.classList.toggle('active', on);
    el.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('.panel').forEach((el) => {
    el.hidden = el.dataset.panel !== tab;
  });
  const clearBtn = document.getElementById('btnClear');
  clearBtn.textContent = tab === 'match' ? '清空匹配' : '清空投递';
}

function renderMatch(records) {
  const tbody = document.getElementById('tbody-match');
  const empty = document.getElementById('empty-match');
  const stats = document.getElementById('stats-match');

  const total = records.length;
  const rec = records.filter((r) => r.recommend).length;
  const avg = total
    ? Math.round(records.reduce((s, r) => s + (Number(r.score) || 0), 0) / total)
    : 0;

  stats.innerHTML = `
    <span>共 ${total} 条</span>
    <span>建议投 ${rec}</span>
    <span>平均分 ${avg}</span>
  `;

  if (!total) {
    tbody.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  tbody.innerHTML = records
    .map((r) => {
      const cls = r.score >= 70 ? 'ok' : 'bad';
      return `<tr>
        <td>${fmtTime(r.updatedAt || r.createdAt)}</td>
        <td class="score ${cls}">${r.score ?? '-'}</td>
        <td>${r.recommend ? '建议' : '跳过'}</td>
        <td>${linkTitle(r)}</td>
        <td>${escapeHtml(r.company || '-')}</td>
        <td>${escapeHtml(r.reason || '-')}</td>
      </tr>`;
    })
    .join('');
}

function renderDeliver(list) {
  const tbody = document.getElementById('tbody-deliver');
  const empty = document.getElementById('empty-deliver');
  const stats = document.getElementById('stats-deliver');

  const greeted = list
    .filter((r) => r.greeted)
    .sort((a, b) => (b.greetedAt || 0) - (a.greetedAt || 0));
  const pending = list.filter((r) => r.recommend && !r.greeted).length;

  stats.innerHTML = `
    <span>已招呼 ${greeted.length}</span>
    <span>待招呼 ${pending}</span>
    <span>结果池 ${list.length}</span>
  `;

  if (!greeted.length) {
    tbody.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  tbody.innerHTML = greeted
    .map((r) => {
      const cls = r.score >= 70 ? 'ok' : 'bad';
      const status =
        r.greetStatus === 'already'
          ? '<span class="tag done">已沟通过</span>'
          : '<span class="tag done">已招呼</span>';
      return `<tr class="row-greeted">
        <td>${fmtTime(r.greetedAt)}</td>
        <td>${status}</td>
        <td class="score ${cls}">${r.score ?? '-'}</td>
        <td>${linkTitle(r)}</td>
        <td>${escapeHtml(r.company || '-')}</td>
        <td>${escapeHtml(decodeBossDigits(r.salary) || '-')}</td>
        <td>${escapeHtml(r.reason || '-')}</td>
      </tr>`;
    })
    .join('');
}

async function load() {
  const [records, results] = await Promise.all([
    send('GET_MATCH_RECORDS'),
    send('GET_RESULT_LIST')
  ]);
  renderMatch(records || []);
  renderDeliver(results || []);
}

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => setTab(btn.dataset.tab));
});

document.getElementById('btnRefresh').addEventListener('click', () => {
  load().catch((e) => alert(e.message));
});

document.getElementById('btnClear').addEventListener('click', async () => {
  if (activeTab === 'match') {
    if (!confirm('确定清空全部匹配记录？')) return;
    await send('CLEAR_MATCH_RECORDS');
  } else {
    if (!confirm('确定清空投递结果列表？面板里的结果也会一并清空。')) return;
    await send('CLEAR_RESULT_LIST');
  }
  await load();
});

// 支持 ?tab=deliver 直达投递结果
const params = new URLSearchParams(location.search);
if (params.get('tab') === 'deliver') setTab('deliver');
else setTab('match');

load().catch((e) => {
  const empty = document.getElementById(
    activeTab === 'match' ? 'empty-match' : 'empty-deliver'
  );
  empty.hidden = false;
  empty.textContent = e.message;
});
