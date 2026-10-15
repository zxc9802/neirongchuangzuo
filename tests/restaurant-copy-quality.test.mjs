import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectCopyQuality } from '../services/restaurant/copy-quality.mjs';

const profile = { name: '桃园火锅', city: '重庆', address: '南滨路二十六号', category: '火锅店' };
const analysis = [{ imageId: 'photo-1', imageType: 'exterior', usable: true, visibleObjects: ['绿植', '木质入口', '夜间灯光', '夜间城景', '远处江面'] }];
const direction = { targetCustomer: '在南滨路散步的朋友', consumptionScene: '晚间散步后找吃饭的地方' };
const goodBody = `如果想约朋友吃一顿火锅，又喜欢城市的夜色，可以把桃园火锅列进这次晚饭的备选。周末见面也好，下班后约一顿也好，先选定吃饭的地方，再慢慢商量各自的安排。我想把我们店这一角的夜色分享给你，也给正在重庆约饭的朋友一个选择。

门口是木质入口，旁边有绿植。暖色的灯光落在木色和绿叶上，这一角看起来柔和。店外的实拍里还能看到夜间城市的灯光与远处江面，我喜欢这种街景和门店外观同框的感觉。喜欢城市夜色的朋友，在选晚饭地点时也许会在意这样的氛围，希望这份柔和的门口气氛，能给朋友相聚添一点期待。

桃园火锅在重庆南滨路二十六号，主营火锅。如果你正在和朋友商量下一顿晚饭，欢迎把我们店放进备选，把这份夜里的气氛当作一次自然的邀约。想约朋友又还没定地方，就借这篇把邀请送给你；如果这份门口夜色刚好合你心意，也欢迎你考虑这一顿。需要来时，搜索桃园火锅并导航到店就好。`;
function goodCopy() { return { titles: ['重庆城市夜色里约朋友吃一顿火锅', '木色绿植和暖灯让门口夜景柔和', '桃园火锅想把这份晚餐邀约送给你'], body: goodBody, coverText: '约一顿火锅见一见朋友', tags: ['重庆火锅', '朋友约饭', '晚饭邀约'] }; }
const inspect = (copy, context = {}) => inspectCopyQuality(copy, { profile, analysis, direction, ...context });

test('a natural owner post with confirmed facts, distinct angles and one navigation ending passes', () => {
  const result = inspect(goodCopy());
  assert.deepEqual(result, { passed: true, issues: [] });
});

test('actual exterior-only failure stays rejected despite reaching the word count', () => {
  const body = `重庆的朋友如果准备来桃园火锅，可以先看看这张门店外观照片，提前辨认一下木质入口的位置。门口的绿植、夜间城市灯光和江面都在画面里，这些视觉线索可以帮助你记住门店的样子，来之前收藏外观会更方便。

晚上找火锅店时，建议先对照这张实拍认清入口，看看照片里的绿植和木质门口，再决定自己的到店安排。桃园火锅属于火锅店，这张照片主要让大家了解门店外观，记住画面中的入口，比只听店名更容易辨认位置。

如果你还没来过桃园火锅，不妨保存这张门口照片，来之前再看一眼入口和绿植。收藏这组外观画面，之后到附近时对照图片找门头，也能记住这处夜间城市背景里的门店。想来就搜索桃园火锅并导航到店。`;
  const result = inspect({ ...goodCopy(), body, titles: ['重庆来桃园火锅先记住这个门口', '重庆来桃园火锅先认准这个门口', '重庆来桃园火锅先收藏这个门口'] });
  assert.equal(result.passed, false);
  assert.ok(result.issues.some(issue => /分析口吻/.test(issue)));
  assert.ok(result.issues.some(issue => /反复提醒/.test(issue)));
});

test('old repeat-three-times placeholder cannot pass by padding a generic paragraph', () => {
  const paragraph = '如果你正在附近安排午餐，可以先看看这些照片，结合自己的时间和喜好决定是否到店。我们希望这组真实画面能帮助你了解门店，具体菜品信息可以到店询问，避免单凭图片猜测。';
  const result = inspect({ ...goodCopy(), body: '我是桃园火锅的老板，分享店里的真实画面。\n\n' + paragraph.repeat(3) });
  assert.equal(result.passed, false);
  assert.ok(result.issues.some(issue => /重复/.test(issue)));
});

test('food-copy editing instructions cannot leak into the public body', () => {
  const result=inspect({...goodCopy(),body:goodBody+'\n不额外延伸菜名或口味描述。'});
  assert.equal(result.passed,false);assert.ok(result.issues.some(issue=>/内部|报告/.test(issue)));
});

test('clinical color-patch descriptions do not become public food copy', () => {
  const result = inspect({ ...goodCopy(), body: goodBody + '\n食品表面有浅金色斑块和棕色斑块。' });
  assert.equal(result.passed, false);
  assert.ok(result.issues.some(issue => /分析描述/.test(issue)));
});

const actualHotpotBody = `想和朋友约一顿火锅时，围着一口锅慢慢聊，是很自然的聚餐选择。桃园火锅，想把这张围桌火锅的画面分享给你：圆锅在桌面中央，周围摆着多只盘碗，聚餐的主题就落在这一桌上。

铜色圆锅里可见红褐色汤汁和红色长条状食材；周边几盘薄片状食材铺开摆放，旁边还有叶片状、浅色片状和菌菇状食材。锅在中间、菜盘围在四周，视觉上层次很丰富，也让人容易想到把不同选择摆上桌，和朋友边吃边聊。

如果你正想约朋友碰面，想找一顿可以围坐分享的晚饭，可以考虑桃园火锅。我们店经营火锅，欢迎感兴趣的朋友把这里作为一次聚餐选择；约上想见的人，一起围着锅吃饭、聊聊天吧。`;

test('the actual hotpot output is rejected for clinical food labels despite valid length and no AI keywords', () => {
  const result = inspect({ ...goodCopy(), body: actualHotpotBody });
  assert.equal(result.passed, false);
  assert.ok(result.issues.some(issue => /食材.*分析描述/.test(issue)));
});

test('replacing clinical ingredient words alone cannot rescue a photo-report dominated body', () => {
  const body = actualHotpotBody.replaceAll('红色长条状食材', '红辣椒').replaceAll('薄片状食材', '切片').replaceAll('叶片状', '绿叶').replaceAll('浅色片状', '浅色切片').replaceAll('菌菇状', '菌菇');
  const result = inspect({ ...goodCopy(), body });
  assert.equal(result.passed, false);
  assert.ok(result.issues.some(issue => /看图报告/.test(issue)));
});

test('plain owner invitations and one photo reference remain allowed without inventing taste, price or meat species', () => {
  const body = `如果和朋友说了好几次“改天聚”，却还没定吃什么，不妨约一顿火锅。把饭局当成一个见面的理由，有话想聊、有近况想听的时候，先把这顿饭约起来。

我们桃园火锅这一桌，铜锅摆在中间，红汤衬着一圈菜盘，颜色看着就热闹。肉片铺在盘里，旁边是绿叶菜和菌菇，照片里也能看到这样的搭配。有人想吃切片，有人想搭些蔬菜，可以把各自想吃的聊一聊；不必每个人都选同一道菜，也不用把一次碰面安排得太隆重。

我想用这一桌的颜色，给还在商量约饭的朋友一点灵感。晚饭想换个相聚的方式，可以来吃一顿火锅，把聊天的时间留给想见的人。桃园火锅在重庆南滨路二十六号，想来可以搜索店名、导航到店；也欢迎把这篇转给约饭搭子，问一句“下次一起吃火锅吗？”`;
  assert.deepEqual(inspect({ ...goodCopy(), body }), { passed: true, issues: [] });
});

test('repeating a long sentence with different punctuation is rejected', () => {
  const sentence = '门口的木质入口与旁边的绿植一起留在这张夜间实拍里';
  const result = inspect({ ...goodCopy(), body: goodBody + '\n' + sentence + '。' + sentence.slice(0, 8) + '，' + sentence.slice(8) + '。' });
  assert.equal(result.passed, false);
  assert.ok(result.issues.some(issue => /至少16个汉字/.test(issue)));
});

test('reordered short clauses cannot disguise two paragraphs containing the same information', () => {
  const clauses = ['门口绿植和木质入口同框', '夜间灯光落在沿江街景里', '画面把门店外观完整留下', '重庆朋友安排沿江的散步', '地址让晚饭地点更加清楚', '老板想把自家日常慢慢分享'];
  const body = goodBody.split('\n\n')[0] + '\n\n' + clauses.join('，') + '。\n\n' + [...clauses].reverse().join('，') + '。';
  const result = inspect({ ...goodCopy(), body });
  assert.equal(result.passed, false);
  assert.ok(result.issues.some(issue => /段落高度重叠/.test(issue)));
});

test('long shared store branding is not treated as a duplicate phrase or identical title angle', () => {
  const longName = '重庆南滨路桃园沿江夜景老街火锅餐厅';
  const copy = goodCopy(); copy.body = copy.body.replaceAll('桃园火锅', longName);
  copy.titles = [longName + '散步后安排晚饭', longName + '老板分享木质入口', longName + '记录沿江夜间日常'];
  assert.deepEqual(inspect(copy, { profile: { ...profile, name: longName } }), { passed: true, issues: [] });
  assert.deepEqual(inspect(copy, { profile: { ...profile, name: longName.slice(0, 8) + '·' + longName.slice(8) } }), { passed: true, issues: [] });
});

test('one legitimate picture or navigation reminder does not make a detailed post generic', () => {
  const copy = goodCopy(); copy.body = copy.body.replace('需要来时，搜索桃园火锅并导航到店就好。', '第一次来可以收藏这张门口照片，再搜索桃园火锅并导航到店。');
  assert.deepEqual(inspect(copy), { passed: true, issues: [] });
});

test('factual picture narration is allowed without internal analysis wording', () => {
  const copy = goodCopy(); copy.body = copy.body.replace('门口是木质入口，旁边有绿植。', '照片里能看到木质入口，旁边是绿植。');
  assert.deepEqual(inspect(copy), { passed: true, issues: [] });
  for (const processPhrase of ['根据照片识别这是火锅店', '无法确认营业时间', '未提供价格', '仅供视觉参考', 'AI分析门口信息']) {
    const result = inspect({ ...copy, body: copy.body + processPhrase + '。' });
    assert.ok(result.issues.some(issue => /分析口吻/.test(issue)), processPhrase);
  }
});

test('photo-evidence disclaimers from the real revised copy stay internal while actual store rules remain publishable', () => {
  const actualSentence = '这些是店外夜景，不代表店内设有观景座位；只是夜色、绿叶和灯光同框的样子，让晚间聚餐多了一种具体的环境想象。';
  for (const disclaimer of [actualSentence, '照片不能证明店内设有江景餐位。', '图片不代表实际的用餐视野。', '画面不等于本店有观景服务。', '这处夜景不代表店内有江景餐位。']) {
    const result = inspect({ ...goodCopy(), body: goodBody + disclaimer });
    assert.equal(result.passed, false);
    assert.ok(result.issues.some(issue => /分析口吻/.test(issue)), disclaimer);
  }
  for (const storeRule of ['店里不提供停车位，过来前请自行安排出行。', '我们没有观景座位，来吃饭可以按自己的需要安排。']) {
    assert.deepEqual(inspect({ ...goodCopy(), body: goodBody + storeRule }), { passed: true, issues: [] });
  }
});

test('a reminder-dominated post is rejected even with no explicit AI words', () => {
  const copy = goodCopy(); copy.body = '桃园火锅在重庆，想来的朋友可以收藏这張门店外观，来之前对照照片认准木质入口，先把位置和样子放在心里。\n\n' +
    '第一次到附近时，建议先看看门口的照片，记住图片中的绿植和木质入口，再把画面保存下来，方便安排自己接下来的到店行程。\n\n' +
    '晚上准备找店时，不妨再看看这张外观图片，认清门口与周围夜间城市背景之间的位置关系，到附近后也可以对照这份实拍。\n\n' +
    '如果以后才打算过来，也可以先保存这张门头照片，需要的时候再翻看门店外观，从入口的样子开始了解桃园火锅，在南滨路走一走时便有一份参考。';
  const result = inspect(copy);
  assert.equal(result.passed, false);
  assert.ok(result.issues.some(issue => /反复提醒/.test(issue)));
});

test('missing confirmed store name is actionable but absent profile never invents a requirement', () => {
  const copy = goodCopy(); copy.body = copy.body.replaceAll('桃园火锅', '我们店');
  assert.ok(inspect(copy).issues.some(issue => /门店名称/.test(issue)));
  assert.deepEqual(inspect(copy, { profile: undefined }), { passed: true, issues: [] });
});

test('only highly similar title wording is rejected, rather than shared category words', () => {
  const copy = goodCopy(); copy.titles = ['南滨路散步后一起安排这顿晚饭', '南滨路散步后一起安排这次晚饭', '重庆老板分享自家江边门口实拍'];
  assert.ok(inspect(copy).issues.some(issue => /标题高度相似/.test(issue)));
  copy.titles = ['重庆火锅老板记录门口夜间日常', '散步结束后在南滨路安排火锅晚饭', '木质入口和绿植是自家火锅店外观'];
  assert.deepEqual(inspect(copy), { passed: true, issues: [] });
});

test('length uses one visible-character definition, includes punctuation and never counts whitespace padding', () => {
  const short = inspect({ ...goodCopy(), body: '桃园火锅的门口有绿植。' + '\n '.repeat(300) });
  assert.ok(short.issues.some(issue => /150—500字符/.test(issue)));
  const long = inspect({ ...goodCopy(), body: goodBody + '。'.repeat(250) });
  assert.ok(long.issues.some(issue => /150—500字符/.test(issue)));
  assert.doesNotThrow(() => inspectCopyQuality(null));
  assert.equal(inspectCopyQuality({ body: goodBody, titles: [null] }).passed, false);
});

test('a sparse-photo brief can stay concise without padding invitations or creating a length confirmation', async () => {
  const { localReview } = await import('../services/restaurant/rules.mjs');
  const body = '想和朋友约一顿饭，又还没定吃什么，不妨提议一顿火锅。围着一锅，按各自喜好搭几盘菜，把下一次见面落在这一餐。\n\n我们这桌的红汤很醒目，肉片和绿叶菜搭在一起，看着挺有食欲。肉片一盘卷着、一盘铺开，我喜欢这样摆在桌上的样子，热闹但不用把聚餐安排得多隆重。\n\n下一顿想吃火锅，欢迎来桃园火锅，把这篇转给想约饭的朋友，一起定个见面的时间。';
  assert.ok([...body.replace(/\s/gu, '')].length >= 150 && [...body.replace(/\s/gu, '')].length < 250);
  const copy = { ...goodCopy(), body, claims: [] };
  assert.deepEqual(inspect(copy), { passed: true, issues: [] });
  assert.ok(!localReview(copy, profile, {}, analysis).warnings.some(warning => /正文长度/.test(warning)));
  assert.ok(inspect({ ...copy, body: body + '薄片状食材。' }).issues.some(issue => /分析描述/.test(issue)));
});
