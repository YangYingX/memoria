import { crc32 } from 'node:zlib';
import { posix } from 'node:path';
import { DOMParser } from 'linkedom';
import yauzl from 'yauzl';

export const BOOK_FILE_MAX_BYTES = 3 * 1024 * 1024;
export const BOOK_TEXT_MAX_CHARS = 1000000;
const MAX_EXPANDED_BYTES = 16 * 1024 * 1024;
const MAX_ENTRIES = 2048;
const MAX_MARKUP_TAGS = 50000;
const CONTAINER_NS = 'urn:oasis:names:tc:opendocument:xmlns:container';
const PACKAGE_NS = 'http://www.idpf.org/2007/opf';
const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const CONTROL = /[\u0000-\u0008\u000b\u000e-\u001f\u007f]/;
const tag = node => String(node.localName || node.nodeName || '').split(':').at(-1).toLowerCase();
const elements = node => [...node.childNodes].filter(child => child.nodeType === 1);
const fail = message => { throw new Error(message); };
const shortTitle = value => value.slice(0, 200).replace(/[\ud800-\udbff]$/, '').trim();

function filename(name) {
  if (typeof name !== 'string' || !name.trim() || name.length > 512 || !name.isWellFormed() || /[\\/\u0000-\u001f\u007f]/.test(name)) fail('请使用名称有效的 TXT 或 EPUB 文件。');
  const clean = name.trim(), match = /\.(txt|epub)$/i.exec(clean);
  if (!match) fail('目前支持 TXT 和 EPUB 书籍，请转换格式后发送。');
  return { name: clean, format: match[1].toUpperCase(), title: shortTitle(clean.slice(0, -match[0].length)) };
}

function checkText(text, format) {
  if (!text.trim() || CONTROL.test(text)) fail(`${format} 正文为空或含有二进制控制字符，请检查后重新发送。`);
  if (text.length > BOOK_TEXT_MAX_CHARS) fail(`${format} 正文超过 1000000 字符，请分章后单独发送。`);
  if (Buffer.byteLength(text, 'utf8') > BOOK_FILE_MAX_BYTES) fail(`${format} 正文超过 3 MiB，请分章后单独发送。`);
  return text;
}

function txt(bytes) {
  const head = bytes.subarray(0, 8).toString('latin1');
  if (/^(?:\x89PNG\r\n\x1a\n|\xff\xd8\xff|GIF8[79]a|RIFF|%PDF-|PK\x03\x04|\x1f\x8b)/.test(head) || bytes.includes(0)) {
    fail('文件不是可读的 TXT 文本，请转换为 UTF-8 编码的 TXT 后发送。');
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail('暂只支持 UTF-8 编码，请将 TXT 转为 UTF-8 后重新发送。'); }
  return checkText(text, 'TXT');
}

function namespace(node) {
  const name = String(node.localName || node.nodeName), colon = name.indexOf(':');
  const key = colon < 0 ? 'xmlns' : `xmlns:${name.slice(0, colon)}`;
  for (let current = node; current?.nodeType === 1; current = current.parentNode) {
    if (current.hasAttribute(key)) return current.getAttribute(key);
  }
  return '';
}

function child(node, name, ns) {
  const found = elements(node).filter(item => tag(item) === name && namespace(item) === ns);
  if (found.length !== 1) fail(`EPUB 缺少唯一的 ${name} 结构，请检查电子书或转换为 TXT。`);
  return found[0];
}

function xml(bytes, rootName, ns, { html = false } = {}) {
  let encoding = 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe || bytes[0] === 0x3c && bytes[1] === 0 && bytes[2] === 0x3f && bytes[3] === 0) encoding = 'utf-16le';
  else if (bytes[0] === 0xfe && bytes[1] === 0xff || bytes[0] === 0 && bytes[1] === 0x3c && bytes[2] === 0 && bytes[3] === 0x3f) encoding = 'utf-16be';
  let source;
  try { source = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch { fail('EPUB 正文须使用有效的 UTF-8 或 UTF-16 编码，请转换为 TXT。'); }
  const declared = /^\s*<\?xml\s[^?]*\bencoding\s*=\s*["']([^"']+)["']/i.exec(source)?.[1]?.toLowerCase();
  if (declared && !(encoding === 'utf-8' ? ['utf-8', 'utf8'].includes(declared) : ['utf-16', 'utf16', encoding].includes(declared))) fail('EPUB 声明的文字编码不支持或与实际内容不符，请转换为 TXT。');
  if (CONTROL.test(source) || /<!ENTITY\b/i.test(source)) fail('EPUB 包含不支持的实体声明或控制字符，请转换为 TXT。');
  // Standard external XHTML DTDs identify a vocabulary; they are never loaded.
  source = source.replace(/<!DOCTYPE\b(?:[^>"'\[]|"[^"\[]*"|'[^'\[]*')*>/gi, '');
  if (/<!DOCTYPE\b/i.test(source)) fail('EPUB 不支持内部 DTD 或损坏的文档声明，请转换为 TXT。');
  let tags = 0;
  for (let i = source.indexOf('<'); i !== -1; i = source.indexOf('<', i + 1)) {
    if (++tags > MAX_MARKUP_TAGS) fail('EPUB 单章标记过于密集，请分章或转换为 TXT。');
  }
  const document = new DOMParser().parseFromString(source, html ? 'text/html' : 'text/xml');
  const roots = elements(document);
  if (roots.length !== 1 || tag(roots[0]) !== rootName || namespace(roots[0]) !== ns) fail(`EPUB 的 ${rootName} 结构无效，请检查电子书或转换为 TXT。`);
  const stack = [{ node: roots[0], depth: 1 }];
  let nodes = 0;
  while (stack.length) {
    const { node, depth } = stack.pop();
    if (++nodes > MAX_MARKUP_TAGS || depth > 128) fail('EPUB 单章结构过于复杂，请分章或转换为 TXT。');
    if (node.nodeType === 1 && node.hasAttribute('xml:base')) fail('EPUB 暂不支持 xml:base，请转换为 TXT。');
    for (const item of node.childNodes) stack.push({ node: item, depth: depth + 1 });
  }
  return roots[0];
}

function archivePath(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\\\u0000-\u001f\u007f]/.test(value) || value.startsWith('/') || /^[^/]*:/.test(value)) fail('EPUB 包含无效的包内路径。');
  const result = posix.normalize(value);
  if (result === '.' || result === '..' || result.startsWith('../')) fail('EPUB 资源路径超出电子书范围。');
  return result;
}

function resourcePath(value, directory = '') {
  if (typeof value !== 'string' || !value || value.length > 8192 || /[?#]/.test(value)) fail('EPUB 资源引用无效，请转换为 TXT。');
  let decoded;
  try { decoded = decodeURIComponent(value); }
  catch { fail('EPUB 包内路径编码无效，请转换为 TXT。'); }
  if (/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(decoded) || /[\\\u0000-\u001f\u007f]/.test(decoded)) fail('EPUB 暂不支持远程或绝对资源路径，不会请求外部内容。');
  return archivePath(directory ? `${directory}/${decoded}` : decoded);
}

function chapterText(root) {
  const body = child(root, 'body', XHTML_NS);
  const skip = new Set(['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'canvas', 'audio', 'video', 'rt', 'rp']);
  const block = new Set(['address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'tr', 'ul']);
  const parts = [], stack = [{ node: body }];
  let chars = 0;
  const append = value => { chars += value.length; if (chars > BOOK_TEXT_MAX_CHARS + MAX_MARKUP_TAGS) fail('EPUB 正文超过 1000000 字符，请分章后单独发送。'); parts.push(value); };
  while (stack.length) {
    const { node, end } = stack.pop();
    if (node.nodeType === 3 || node.nodeType === 4) { append(node.data.replace(/\s+/g, ' ')); continue; }
    if (node.nodeType !== 1) continue;
    const name = tag(node);
    if (skip.has(name) || node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true') continue;
    if (block.has(name)) append('\n');
    if (end) continue;
    if (name === 'td' || name === 'th') append(' ');
    if (block.has(name)) stack.push({ node, end: true });
    const children = [...node.childNodes];
    for (let i = children.length - 1; i >= 0; i--) stack.push({ node: children[i] });
  }
  return parts.join('').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

async function epub(bytes, signal) {
  let zip, current;
  const abort = () => current?.destroy(new Error('电子书接收已取消。'));
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    zip = await yauzl.fromBufferPromise(bytes, { strictFileNames: true, validateEntrySizes: true });
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(zip.entryCount) || zip.entryCount > MAX_ENTRIES) fail('EPUB 文件条目超过 2048 项，请拆分电子书。');
    const entries = new Map();
    let declared = 0, readBytes = 0;
    for await (const entry of zip.eachEntry()) {
      signal?.throwIfAborted();
      const path = archivePath(entry.fileName);
      if (entries.has(path)) fail('EPUB 包含重复的文件路径，未导入。');
      if (entries.size >= MAX_ENTRIES || !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0
        || (declared += entry.uncompressedSize) > MAX_EXPANDED_BYTES) fail('EPUB 声明的解压内容超过 16 MiB 或条目过多，请拆分电子书。');
      if (!entry.canDecodeFileData() || ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) fail('EPUB 含有加密、链接或不支持压缩方式的文件，请转换为 TXT。');
      entries.set(path, entry);
    }
    const read = async (path, limit) => {
      signal?.throwIfAborted();
      const entry = entries.get(path);
      if (!entry || path.endsWith('/')) fail('EPUB 缺少引用的资源，未导入不完整正文。');
      if (entry.uncompressedSize > limit) fail('EPUB 单项解压内容超过限制，请拆分电子书。');
      current = await zip.openReadStreamPromise(entry);
      current.on('error', () => {});
      const stream = current, chunks = [];
      let size = 0, checksum = 0;
      try {
        signal?.throwIfAborted();
        for await (const chunk of stream) {
          signal?.throwIfAborted();
          size += chunk.length; readBytes += chunk.length;
          if (size > limit || readBytes > MAX_EXPANDED_BYTES) fail('EPUB 实际解压内容超过限制，请拆分电子书。');
          checksum = crc32(chunk, checksum);
          chunks.push(chunk);
        }
        signal?.throwIfAborted();
        if (size !== entry.uncompressedSize || checksum !== entry.crc32) fail('EPUB 文件校验失败，请重新下载电子书后发送。');
        return Buffer.concat(chunks, size);
      } finally { stream.destroy(); current = null; }
    };
    if (!(await read('mimetype', 20)).equals(Buffer.from('application/epub+zip'))) fail('文件不是有效的 EPUB 电子书，请转换为 TXT。');
    const container = xml(await read('META-INF/container.xml', 64 * 1024), 'container', CONTAINER_NS);
    const rootfiles = elements(child(container, 'rootfiles', CONTAINER_NS)).filter(item => tag(item) === 'rootfile' && namespace(item) === CONTAINER_NS);
    const first = rootfiles.find(item => item.getAttribute('media-type') === 'application/oebps-package+xml');
    if (!first) fail('EPUB 缺少支持的书籍目录，请转换为 TXT。');
    const packagePath = resourcePath(first.getAttribute('full-path'));
    const protectedPaths = new Set();
    if (entries.has('META-INF/encryption.xml')) {
      const encryption = xml(await read('META-INF/encryption.xml', 256 * 1024), 'encryption', CONTAINER_NS);
      for (const node of encryption.querySelectorAll('*')) {
        if (tag(node) === 'cipherreference') protectedPaths.add(resourcePath(node.getAttribute('URI')));
      }
      if (!protectedPaths.size) fail('EPUB 加密说明无效，请转换为未加密 TXT。');
    }
    if (protectedPaths.has(packagePath)) fail('EPUB 的书籍目录已受加密保护，不支持解密或 DRM。');
    const pkg = xml(await read(packagePath, 256 * 1024), 'package', PACKAGE_NS);
    if (!['2.0', '3.0'].includes(pkg.getAttribute('version'))) fail('暂只支持 EPUB 2 或 EPUB 3 电子书。');
    const metadata = child(pkg, 'metadata', PACKAGE_NS);
    const titleNode = [...metadata.querySelectorAll('*')].find(node => tag(node) === 'title' && namespace(node) === 'http://purl.org/dc/elements/1.1/');
    const title = titleNode ? shortTitle(titleNode.textContent.replace(/\s+/g, ' ')) : '';
    if (CONTROL.test(title) || !title.isWellFormed()) fail('EPUB 书名无效，请检查元数据。');
    const manifest = new Map();
    for (const item of elements(child(pkg, 'manifest', PACKAGE_NS))) {
      if (tag(item) !== 'item' || namespace(item) !== PACKAGE_NS) continue;
      const id = item.getAttribute('id');
      if (!id || manifest.has(id)) fail('EPUB 目录含有缺失或重复的资源 ID，未导入。');
      manifest.set(id, item);
    }
    const directory = posix.dirname(packagePath), seen = new Set(), paths = new Set(), texts = [];
    let chars = 0, textBytes = 0;
    for (const item of elements(child(pkg, 'spine', PACKAGE_NS))) {
      if (tag(item) !== 'itemref' || namespace(item) !== PACKAGE_NS) continue;
      const id = item.getAttribute('idref'), resource = manifest.get(id);
      if (!resource || seen.has(id)) fail('EPUB 阅读顺序引用缺失或重复，未导入。');
      seen.add(id);
      if (resource.getAttribute('media-type') !== 'application/xhtml+xml') fail('EPUB 含有暂不支持的非 XHTML 正文章节，请转换为 TXT，避免漏章。');
      const path = resourcePath(resource.getAttribute('href'), directory === '.' ? '' : directory);
      if (paths.has(path)) fail('EPUB 阅读顺序重复引用同一文件，未导入。');
      paths.add(path);
      if (protectedPaths.has(path)) fail('EPUB 正文已受加密保护，不支持解密或 DRM。');
      const text = chapterText(xml(await read(path, BOOK_FILE_MAX_BYTES), 'html', XHTML_NS, { html: true }));
      signal?.throwIfAborted();
      if (!text) continue;
      chars += text.length + (texts.length ? 2 : 0);
      textBytes += Buffer.byteLength(text, 'utf8') + (texts.length ? 2 : 0);
      if (chars > BOOK_TEXT_MAX_CHARS || textBytes > BOOK_FILE_MAX_BYTES) fail('EPUB 正文超过 1000000 字符或 3 MiB，请分章后单独发送。');
      texts.push(text);
    }
    if (!seen.size) fail('EPUB 没有可用的阅读顺序，请转换为 TXT。');
    return { text: checkText(texts.join('\n\n'), 'EPUB'), title };
  } catch (error) {
    signal?.throwIfAborted();
    if (/EPUB|电子书|UTF-|DTD|DRM/.test(error?.message || '')) throw error;
    fail('EPUB 压缩包损坏或格式不受支持，请重新下载或转换为 TXT。');
  } finally {
    signal?.removeEventListener('abort', abort);
    current?.destroy();
    zip?.close();
  }
}

export async function parseBookFile({ name, bytes, title, signal } = {}) {
  const file = filename(name);
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > BOOK_FILE_MAX_BYTES) fail('书籍文件为空或超过 3 MiB，请分章后单独发送。');
  bytes = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (title !== undefined && (typeof title !== 'string' || title.length > 200 || !title.isWellFormed() || CONTROL.test(title))) fail('书名须为不超过 200 字符的文本。');
  signal?.throwIfAborted();
  const parsed = file.format === 'TXT' ? { text: txt(bytes) } : await epub(bytes, signal);
  signal?.throwIfAborted();
  const bookTitle = title?.trim() || parsed.title || file.title;
  if (!bookTitle) fail('请为文件填写书名后重新发送。');
  return { title: bookTitle, text: parsed.text };
}
