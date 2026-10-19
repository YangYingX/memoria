export function parseQQMessage(event) {
  const segments = Array.isArray(event.message) ? event.message : [];
  const message = segments.length
    ? segments.filter(segment => segment?.type === 'text' && typeof segment.data?.text === 'string').map(segment => segment.data.text).join('').trim()
    : String(event.raw_message || '').replace(/\[CQ:[^\]]*\]/g, '').trim();
  return { message, imageUrls: segments.filter(segment => segment?.type === 'image').map(segment => segment.data?.url) };
}
