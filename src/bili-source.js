import { createHash } from 'node:crypto';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const positive = value => Number.isSafeInteger(value) && value > 0;
const text = (value, max) => typeof value === 'string' && value.trim() && value.length <= max && value.isWellFormed() && !value.includes('\0');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const models = value => text(value, 200) && /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(value)
  && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) && !/^[A-Za-z]:\//.test(value);

export function biliMediaSourceId({ bvid, page, cid }) {
  return createHash('sha256').update(JSON.stringify([bvid, page, cid])).digest('hex');
}

export function isBiliSourceEvidence(evidence, bvid, videoPart) {
  if (!object(evidence) || evidence.bvid !== bvid || evidence.videoPart !== videoPart) return false;
  // Keep the established transcript route independent of the new media route.
  if (evidence.sourceKind === 'bilibili-transcript' && evidence.plugin === 'dsh-bili-humanism'
    && ['A1', 'A2'].includes(evidence.route) && evidence.visual === false && evidence.audio === false) return true;
  if (!exact(evidence, ['sourceKind', 'plugin', 'sourceId', 'bvid', 'videoPart', 'cid', 'author', 'route', 'coverage', 'frames', 'speech', 'visual', 'audio'])
    || evidence.sourceKind !== 'bilibili-media-observation' || evidence.plugin !== 'memoria-bili-media' || evidence.route !== 'M1'
    || typeof bvid !== 'string' || !/^BV[0-9A-Za-z]{10}$/.test(bvid) || !positive(videoPart) || videoPart > 100
    || !positive(evidence.cid) || evidence.sourceId !== biliMediaSourceId({ bvid, page: videoPart, cid: evidence.cid })
    || !text(evidence.author, 200) || !Array.isArray(evidence.frames) || evidence.frames.length > 8
    || !Array.isArray(evidence.speech) || evidence.speech.length > 1
    || evidence.visual !== (evidence.frames.length > 0) || evidence.audio !== (evidence.speech.length > 0)) return false;
  const coverage = evidence.coverage;
  if (!exact(coverage, ['state', 'sampled', 'durationSeconds', 'processedAudioUntil', 'frameTimes', 'speechIntervals', 'textRoute', 'textSourceId', 'missing', 'note'])
    || coverage.state !== 'partial' || coverage.sampled !== evidence.visual
    || !Number.isFinite(coverage.durationSeconds) || coverage.durationSeconds <= 0 || coverage.durationSeconds > 12 * 3600
    || !Number.isFinite(coverage.processedAudioUntil) || coverage.processedAudioUntil < 0
    || coverage.processedAudioUntil > Math.min(60, coverage.durationSeconds)
    || !Array.isArray(coverage.frameTimes) || !Array.isArray(coverage.speechIntervals)
    || !text(coverage.missing, 1000) || !text(coverage.note, 1000)
    || !(coverage.textRoute === null && coverage.textSourceId === null
      || ['A1', 'A2'].includes(coverage.textRoute) && text(coverage.textSourceId, 128))
    || !evidence.visual && !evidence.audio && coverage.textRoute === null) return false;
  let previous = -1;
  for (const frame of evidence.frames) {
    if (!exact(frame, ['at', 'sha256', 'model']) || !Number.isFinite(frame.at) || frame.at < 0
      || frame.at <= previous || frame.at > coverage.durationSeconds || !digest(frame.sha256) || !models(frame.model)) return false;
    previous = frame.at;
  }
  for (const segment of evidence.speech) {
    if (!exact(segment, ['startSeconds', 'endSeconds', 'sha256', 'model'])
      || !Number.isFinite(segment.startSeconds) || !Number.isFinite(segment.endSeconds) || segment.startSeconds < 0
      || segment.endSeconds <= segment.startSeconds || segment.endSeconds - segment.startSeconds > 60
      || segment.endSeconds > coverage.processedAudioUntil || !digest(segment.sha256) || !models(segment.model)) return false;
  }
  return JSON.stringify(coverage.frameTimes) === JSON.stringify(evidence.frames.map(frame => frame.at))
    && JSON.stringify(coverage.speechIntervals) === JSON.stringify(evidence.speech.map(segment => [segment.startSeconds, segment.endSeconds]));
}

export function biliCoverageNotice(evidence) {
  if (evidence.route !== 'M1') return '仅取得本视频的字幕或平台文字摘录，未观看画面或收听原声；摘录与文字覆盖均不代表完整视频。';
  return `本次取得${evidence.frames.length}个画面时点的模型观察、${evidence.speech.length ? '一段最多60秒的机器语音转写' : '未取得可用语音转写'}${evidence.coverage.textRoute ? '，并取得字幕或平台文字' : ''}。仅限给出的实际观察与文字，未抽样画面、未处理声音、音乐及音效均未知；不代表完整观影或听懂原声。`;
}
