/**
 * 从本地简历文件提取纯文本。
 * 支持：txt / md / docx
 * 不支持：旧版 .doc（需另存为 docx）
 */

function extOf(name = '') {
  const m = String(name).toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : '';
}

function decodeXmlEntities(text) {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#([0-9]+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

export async function extractResumeText(file) {
  if (!file) throw new Error('未选择文件');
  const ext = extOf(file.name);
  const type = file.type || '';

  if (ext === 'doc') {
    throw new Error('暂不支持旧版 .doc，请用 Word「另存为」成 .docx 后再上传');
  }

  if (
    ext === 'docx' ||
    type.includes('wordprocessingml') ||
    type.includes('officedocument.wordprocessingml')
  ) {
    return extractDocx(file);
  }

  if (ext === 'txt' || ext === 'md' || ext === 'text' || type.startsWith('text/')) {
    const text = await file.text();
    if (!text.trim()) throw new Error('文件内容为空');
    return text;
  }

  if (!ext && type === '') {
    const text = await file.text();
    if (!text.trim()) throw new Error('文件内容为空');
    return text;
  }

  throw new Error(`暂不支持 .${ext || '未知'} 格式，请上传 .docx / .txt / .md`);
}

async function extractDocx(file) {
  const JSZip = globalThis.JSZip;
  if (!JSZip) {
    throw new Error('Word 解析库未加载，请到扩展页刷新后重试');
  }

  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const docFile = zip.file('word/document.xml');
  if (!docFile) {
    throw new Error('不是有效的 .docx（缺少 document.xml）');
  }

  const xml = await docFile.async('string');
  const parts = [];
  const re =
    /<\/w:p>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>|<w:t\b[^>]*xml:space="preserve"[^>]*>([\s\S]*?)<\/w:t>|<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g;
  let m;
  while ((m = re.exec(xml))) {
    const token = m[0];
    if (token.startsWith('</w:p') || token.startsWith('<w:br')) {
      parts.push('\n');
    } else if (token.startsWith('<w:tab')) {
      parts.push('\t');
    } else {
      parts.push(m[1] ?? m[2] ?? '');
    }
  }
  const text = decodeXmlEntities(parts.join(''))
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!text) {
    throw new Error('未能从 Word 中提取到文本，请检查文件或另存为 .docx');
  }
  return text;
}
