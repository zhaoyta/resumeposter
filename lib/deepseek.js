/**
 * DeepSeek Chat Completions helper (runs in service worker).
 */

function joinUrl(base, path) {
  return `${base.replace(/\/+$/, '')}${path}`;
}

export async function chatCompletion({ apiBase, apiKey, model, messages, temperature = 0.2 }) {
  if (!apiKey) {
    throw new Error('未配置 DeepSeek API Key');
  }
  const url = joinUrl(apiBase || 'https://api.deepseek.com', '/chat/completions');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model || 'deepseek-chat',
      messages,
      temperature,
      response_format: { type: 'json_object' }
    })
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`DeepSeek 返回非 JSON：${text.slice(0, 200)}`);
  }

  if (!res.ok) {
    const msg = data?.error?.message || text.slice(0, 200);
    throw new Error(`DeepSeek 请求失败 (${res.status}): ${msg}`);
  }

  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('DeepSeek 无有效回复');
  }
  return content;
}

export function parseJsonContent(content) {
  const raw = String(content).trim();
  try {
    return JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('无法解析模型 JSON 输出');
  }
}

export async function summarizeResume(settings, resumeText) {
  const content = await chatCompletion({
    ...settings,
    messages: [
      {
        role: 'system',
        content:
          '你是求职助手。请把简历提炼为简洁结构化摘要，输出 JSON：{"summary":"200字内摘要","skills":[],"years":"工作年限描述","targetRoles":[],"avoid":[]}'
      },
      { role: 'user', content: resumeText.slice(0, 12000) }
    ]
  });
  return parseJsonContent(content);
}

export async function matchJob(settings, { resumeSummary, resumeText, criteriaText, job }) {
  const resumeBlock = resumeSummary || resumeText.slice(0, 8000);
  const jd = [
    `职位：${job.title || ''}`,
    `公司：${job.company || ''}`,
    `薪资：${job.salary || ''}`,
    `地点：${job.location || ''}`,
    `标签：${(job.tags || []).join(' / ')}`,
    `活跃：${job.bossActive || ''}`,
    '',
    '职位描述：',
    (job.description || '').slice(0, 6000)
  ].join('\n');

  const content = await chatCompletion({
    ...settings,
    messages: [
      {
        role: 'system',
        content: `你是严谨的求职匹配助手。根据候选人简历、求职条件与 JD 判断是否值得打招呼。
只输出 JSON：
{
  "score": 0-100整数,
  "recommend": true/false,
  "reason": "一句话理由",
  "pros": ["匹配点"],
  "cons": ["风险点"],
  "missing": ["JD要求但简历不明显的点"]
}
评分参考：90+强匹配，70-89可投，50-69犹豫，<50不建议。
若 JD 命中求职禁忌词或明显不符（外包/驻场等且条件要求避开），score 应明显压低。`
      },
      {
        role: 'user',
        content: `【求职条件】\n${criteriaText || '无额外条件'}\n\n【简历摘要/正文】\n${resumeBlock}\n\n【JD】\n${jd}`
      }
    ]
  });

  const result = parseJsonContent(content);
  const score = Math.max(0, Math.min(100, Number(result.score) || 0));
  const threshold = Number(settings.matchThreshold) || 70;
  return {
    score,
    recommend: typeof result.recommend === 'boolean' ? result.recommend : score >= threshold,
    reason: result.reason || '',
    pros: Array.isArray(result.pros) ? result.pros : [],
    cons: Array.isArray(result.cons) ? result.cons : [],
    missing: Array.isArray(result.missing) ? result.missing : []
  };
}

/**
 * 批量匹配：一次请求打分多个职位（用列表信息，追求速度）
 * @returns {Array<{jobId, score, recommend, reason}>}
 */
export async function matchJobsBatch(settings, { resumeSummary, resumeText, criteriaText, jobs }) {
  const resumeBlock = (resumeSummary || resumeText || '').slice(0, 6000);
  const list = (jobs || []).slice(0, 12).map((j, i) => ({
    i,
    jobId: j.jobId || '',
    title: j.title || '',
    company: j.company || '',
    salary: j.salary || '',
    location: j.location || '',
    tags: (j.tags || []).slice(0, 8),
    snippet: (j.description || '').slice(0, 400)
  }));

  const content = await chatCompletion({
    ...settings,
    messages: [
      {
        role: 'system',
        content: `你是求职匹配助手。根据简历与求职条件，对岗位列表批量打分。
只输出 JSON：
{"items":[{"i":0,"jobId":"","score":0-100,"recommend":true/false,"reason":"一句话"}]}
规则：90+强匹配，70-89可投，<70不建议。命中外包/驻场等禁忌则低分。每个输入岗位都要有对应输出。`
      },
      {
        role: 'user',
        content: `【求职条件】\n${criteriaText || '无'}\n\n【简历】\n${resumeBlock}\n\n【岗位列表】\n${JSON.stringify(list)}`
      }
    ]
  });

  const parsed = parseJsonContent(content);
  const items = Array.isArray(parsed.items) ? parsed.items : Array.isArray(parsed) ? parsed : [];
  const threshold = Number(settings.matchThreshold) || 70;
  const byIndex = new Map(items.map((it) => [Number(it.i), it]));

  return list.map((j) => {
    const it = byIndex.get(j.i) || items.find((x) => x.jobId && x.jobId === j.jobId) || {};
    const score = Math.max(0, Math.min(100, Number(it.score) || 0));
    let recommend = typeof it.recommend === 'boolean' ? it.recommend : score >= threshold;
    if (score < threshold) recommend = false;
    return {
      jobId: j.jobId,
      score,
      recommend,
      reason: it.reason || '',
      pros: [],
      cons: [],
      missing: []
    };
  });
}

/**
 * 根据简历摘要/正文 + 投递条件，生成可轮换的 Boss 搜索关键词
 */
export async function generateSearchKeywords(settings, { resumeSummary, resumeText, criteriaText }) {
  const resumeBlock = (resumeSummary || resumeText || '').slice(0, 8000);
  if (!resumeBlock.trim()) {
    throw new Error('请先配置简历或生成简历摘要');
  }
  const content = await chatCompletion({
    ...settings,
    messages: [
      {
        role: 'system',
        content: `你是求职搜索助手。根据简历与求职条件，生成适合在 Boss 直聘搜索框使用的关键词列表。
只输出 JSON：
{"keywords":["词1","词2","词3"],"reason":"一句话说明"}
要求：
- 3~8 个词，短、可直接搜（职位名/技术栈/方向），不要句子
- 覆盖主方向与常见别名（如 Java、后端开发、Spring Boot）
- 不要公司名、不要城市、不要薪资
- 不要重复，不要太宽泛的单字`
      },
      {
        role: 'user',
        content: `【求职条件】\n${criteriaText || '无额外条件'}\n\n【简历】\n${resumeBlock}`
      }
    ]
  });
  const parsed = parseJsonContent(content);
  const keywords = (Array.isArray(parsed.keywords) ? parsed.keywords : [])
    .map((s) => String(s || '').trim())
    .filter(Boolean);
  const uniq = [...new Set(keywords)].slice(0, 10);
  if (!uniq.length) throw new Error('未能生成关键词，请补充简历或条件后再试');
  return { keywords: uniq, reason: parsed.reason || '' };
}

export async function mapSearchFilters(settings, criteriaText) {
  const content = await chatCompletion({
    ...settings,
    messages: [
      {
        role: 'system',
        content: `把自然语言求职条件映射为 Boss 直聘筛选项 JSON：
{
  "query": "主搜索词",
  "queries": ["关键词1","关键词2","关键词3"],
  "city": "城市名，如杭州",
  "jobType": 0|1901|1903,
  "salary": 0|402|403|404|405|406|407,
  "experience": 0|108|102|101|103|104|105|106|107,
  "degree": 0|209|208|206|202|203|204|205,
  "scale": 0|301|302|303|304|305|306,
  "excludeKeywords": ["外包"]
}
queries：根据意向拆成 2-6 个可轮换的搜索词（如 Java、后端开发、Spring），不要重复，不要太长。
枚举含义：
jobType: 0不限 1901全职 1903兼职
salary: 0不限 402<3K 403 3-5K 404 5-10K 405 10-20K 406 20-50K 407 >50K
experience: 0不限 108在校 102应届 101经验不限 103<1年 104 1-3 105 3-5 106 5-10 107>10
degree: 0不限 209初中及以下 208中专/中技 206高中 202大专 203本科 204硕士 205博士
scale: 0不限 301<20 302 20-99 303 100-499 304 500-999 305 1000-9999 306>10000
不确定的字段填 0。`
      },
      { role: 'user', content: criteriaText }
    ]
  });
  return parseJsonContent(content);
}
