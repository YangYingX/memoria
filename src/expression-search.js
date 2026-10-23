function fields(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
    && Object.keys(value).every(key => keys.includes(key));
}

export function expressionSearchQuery(query) {
  if (typeof query !== 'string' || !query.trim() || query.trim().length > 80) throw new Error('表情检索词须为 1–80 字。');
  return query.trim();
}

export function expressionSearchItems(items) {
  const seen = new Set();
  if (!Array.isArray(items) || items.length > 128) throw new Error('表情检索目录无效。');
  return items.map(item => {
    if (!fields(item, ['id', 'name', 'description']) || typeof item.id !== 'string'
      || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(item.id) || seen.has(item.id)
      || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 80
      || typeof item.description !== 'string' || item.description.length > 500) throw new Error('表情检索目录无效。');
    seen.add(item.id);
    return { id: item.id, name: item.name, description: item.description };
  });
}

export function expressionSearchResult(value, items) {
  if (!fields(value, ['expressions', 'engine']) || value.engine !== 'dsh-meme'
    || !Array.isArray(value.expressions) || value.expressions.length > 6) throw new Error('表情检索结果无效。');
  const source = new Map(expressionSearchItems(items).map(item => [item.id, item]));
  const matches = expressionSearchItems(value.expressions);
  for (const item of matches) {
    if (!source.has(item.id) || JSON.stringify(item) !== JSON.stringify(source.get(item.id))) throw new Error('表情检索返回了目录以外的内容。');
  }
  return { expressions: matches, engine: 'dsh-meme' };
}
