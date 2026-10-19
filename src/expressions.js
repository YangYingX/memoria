import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'expressions');
const MAX_BYTES = 8 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const catalog = [
  { id: 'hello', name: '打招呼', description: '微笑挥手，用于见面、问候或欢迎回来。' },
  { id: 'happy', name: '开心', description: '明亮开心的笑容，用于好消息、感谢或分享喜悦。' },
  { id: 'thinking', name: '思考', description: '托腮思考，用于好奇、斟酌或一起想办法。' },
  { id: 'pout', name: '小委屈', description: '轻轻鼓脸，用于熟悉关系中的玩笑或小小委屈，不用于指责对方。' },
  { id: 'comfort', name: '安慰', description: '温柔地张开双手，用于陪伴、鼓励或安慰。' },
  { id: 'sleepy', name: '困困', description: '困倦地揉眼睛，用于晚安、休息或轻松表达困意。' },
  { id: 'received', name: '收到！', description: '认真又有活力地回应，用于确认收到消息或理解对方的安排。' },
  { id: 'yay', name: '好耶！', description: '雀跃地庆祝，用于达成小目标、分享好消息或开心赞同。' },
  { id: 'thanks', name: '辛苦啦', description: '温柔地表达感谢和体谅，用于对方忙完事情或付出努力之后。' },
  { id: 'hug', name: '抱抱你', description: '张开双手给一个温暖的拥抱，用于对方愿意接受的安慰和陪伴。' },
  { id: 'steady', name: '稳住，能行', description: '坚定地打气，用于有压力时鼓励对方一步步来，不保证未知结果。' },
  { id: 'look', name: '我先看看', description: '好奇认真地观察，用于接到新信息、图片或一起了解一件事时。' },
  { id: 'goodnight', name: '晚安好梦', description: '柔和地道晚安，用于睡前告别、提醒休息或祝愿好梦。' },
  { id: 'cheer', name: '一起加油', description: '充满元气地相互鼓励，用于共同努力、重新开始或支持对方。' },
  { id: 'loading', name: '脑袋加载中', description: '脑袋暂时卡住、需要思考时。' },
  { id: 'bubble', name: '偷偷冒泡', description: '久未发言后轻轻出现或打招呼。' },
  { id: 'recharge', name: '满血复活', description: '休息后恢复精神、重新出发。' },
  { id: 'fine', name: '问题不大', description: '轻松安抚或表示小问题可以处理。' },
  { id: 'peek', name: '让我康康', description: '好奇想了解、看看新信息。' },
  { id: 'twirl', name: '快乐转圈', description: '分享纯粹的开心和雀跃。' },
  { id: 'morning', name: '早上好呀', description: '早间问候和开启新一天。' },
  { id: 'back', name: '我回来啦', description: '离开一会后回到聊天。' },
  { id: 'bye', name: '回头见呀', description: '暂时离开或轻松告别。' },
  { id: 'here', name: '我在呢', description: '回应呼唤、表示在听和陪伴。' },
  { id: 'nod', name: '好的呀', description: '自然答应或确认简单安排。' },
  { id: 'understood', name: '懂你意思', description: '表示理解对方的想法。' },
  { id: 'wait', name: '等我一下', description: '请对方稍候片刻。' },
  { id: 'noted', name: '记下来啦', description: '表示已经记下提醒或重点。' },
  { id: 'agree', name: '赞同！', description: '赞同想法、附和观点。' },
  { id: 'wow', name: '哇哦！', description: '遇到让人惊喜的新消息。' },
  { id: 'applause', name: '给你鼓掌', description: '为努力或成果喝彩。' },
  { id: 'praise', name: '你真棒呀', description: '真诚表扬对方的表现。' },
  { id: 'grateful', name: '谢谢你呀', description: '收到帮助或礼物后表达感谢。' },
  { id: 'flower', name: '送你小花', description: '送上善意、安慰或小奖励。' },
  { id: 'learning', name: '认真学习', description: '一起学习或进入学习状态。' },
  { id: 'focused', name: '专注模式', description: '暂时专心做事或工作。' },
  { id: 'homework', name: '写完啦！', description: '完成作业、任务或一项工作。' },
  { id: 'working', name: '开工啦！', description: '开始工作、准备行动。' },
  { id: 'break', name: '摸鱼一会', description: '轻松调侃短暂偷闲。' },
  { id: 'coffee', name: '咖啡续航', description: '工作学习间隙补充精神。' },
  { id: 'tea', name: '喝水时间', description: '温和提醒补水或一起休息。' },
  { id: 'lunch', name: '干饭啦！', description: '到了饭点或分享吃饭心情。' },
  { id: 'game', name: '开黑吗？', description: '邀请组队玩游戏。' },
  { id: 'ready', name: '准备就绪', description: '表示准备好了、可以开始。' },
  { id: 'victory', name: '赢啦！', description: '庆祝游戏胜利或达成目标。' },
  { id: 'retry', name: '再来一局', description: '想再玩一局或重新尝试。' },
  { id: 'teammate', name: '神仙队友', description: '夸赞队友配合和帮助。' },
  { id: 'support', name: '我来助攻', description: '主动提供帮助或配合。' },
  { id: 'patient', name: '慢慢来呀', description: '减少催促、鼓励按自己的节奏。' },
  { id: 'brave', name: '你可以的', description: '支持对方面对挑战。' },
  { id: 'progress', name: '又进步啦', description: '发现成长或认可进步。' },
  { id: 'start', name: '今天也行', description: '开启一天、给自己和对方鼓劲。' },
  { id: 'rest', name: '休息一下', description: '忙碌后建议歇一歇。' },
  { id: 'stretch', name: '伸个懒腰', description: '久坐后放松或睡醒伸展。' },
  { id: 'cosy', name: '贴贴充电', description: '熟悉关系中的亲近和温柔陪伴。' },
  { id: 'wink', name: '懂的都懂', description: '轻松默契或无恶意的小玩笑。' },
  { id: 'confused', name: '咦？', description: '听到意外信息时好奇询问。' },
  { id: 'gasp', name: '我震惊了', description: '对夸张趣事表达惊讶。' },
  { id: 'smug', name: '嘿嘿嘿', description: '开小玩笑或轻松得意一下。' },
  { id: 'celebrate', name: '撒花庆祝', description: '庆祝完成、好消息和开心时刻。' },
];

function entryFor(id) {
  const entry = typeof id === 'string' && catalog.find(item => item.id === id);
  if (!entry) throw new Error('表情 ID 不在允许的目录中。');
  return entry;
}

function available(entry) {
  try {
    const info = lstatSync(join(directory, `${entry.id}.png`));
    return info.isFile() && !info.isSymbolicLink() && info.size >= PNG_SIGNATURE.length && info.size <= MAX_BYTES;
  } catch { return false; }
}

export function getExpressionCatalog() {
  return catalog.filter(available).map(entry => ({ ...entry }));
}

export function getExpressionPreviews() {
  return getExpressionCatalog().map(entry => ({ ...entry, previewPath: `/expressions/${entry.id}.png` }));
}

export function readExpressionImage(id) {
  const entry = entryFor(id);
  if (!available(entry)) throw new Error('表情资源未就绪或超过 8 MiB 限制。');
  let bytes;
  try { bytes = readFileSync(join(directory, `${entry.id}.png`)); }
  catch { throw new Error('无法读取表情资源。'); }
  if (bytes.length > MAX_BYTES || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new Error('表情资源不是受支持的 PNG 图片或超过大小限制。');
  return bytes;
}

export function buildExpressionSegments(ids = []) {
  if (!Array.isArray(ids) || ids.length > 1) throw new Error('每条回复最多使用一张表情。');
  return ids.map(id => ({ type: 'image', data: { file: `base64://${readExpressionImage(id).toString('base64')}` } }));
}
