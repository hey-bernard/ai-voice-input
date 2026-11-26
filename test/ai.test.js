const test = require('node:test');
const assert = require('node:assert');
const { buildPolishRequest, parsePolishResponse, findTone, createAi } = require('../src/main/ai.js');

test('다듬기 요청에 말투·원문·문맥과 구조화 출력, 폴백이 들어간다', () => {
  const tone = findTone('casual');
  const req = buildPolishRequest({ text: '어 그러니까 내일 회의 세시에 해요', tone, context: ['오늘 회의는 끝났어요.'], model: 'claude-opus-5-5', effort: 'low' });
  assert.equal(req.model, 'claude-opus-5-5');
  assert.equal(req.fallbacks, 'default');
  assert.deepEqual(req.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(req.output_config.effort, 'low');
  assert.equal(req.output_config.format.type, 'json_schema');
  assert.ok(!('thinking' in req));
  const content = req.messages[0].content;
  assert.match(content, /친근하고 편안하게/);
  assert.match(content, /<transcript>\n어 그러니까 내일 회의 세시에 해요\n<\/transcript>/);
  assert.match(content, /오늘 회의는 끝났어요/);
});

test('맞춤 말투를 id 로 찾고, 없는 id 는 기본 말투로 대체한다', () => {
  const custom = [{ id: 'c1', name: '보고서체', instruction: '~함 체' }];
  assert.equal(findTone('c1', custom).name, '보고서체');
  assert.equal(findTone('nope', custom).id, 'formal');
});

test('응답 JSON 에서 다듬은 문장을 꺼낸다', () => {
  const text = parsePolishResponse({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"text":" 내일 회의는 3시에 해요. "}' }] });
  assert.equal(text, '내일 회의는 3시에 해요.');
});

test('거절·잘림 응답은 오류로 처리해 원문을 쓰게 한다', () => {
  assert.throws(() => parsePolishResponse({ stop_reason: 'refusal', content: [] }), (e) => e.code === 'refusal');
  assert.throws(() => parsePolishResponse({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"te' }] }), (e) => e.code === 'max_tokens');
});

test('원문 말투는 API 를 호출하지 않고 그대로 돌려준다', async () => {
  const ai = createAi({ getKeys: () => ({}), getSettings: () => ({ customTones: [] }) });
  const res = await ai.polish({ text: '그대로', toneId: 'raw' });
  assert.deepEqual(res, { ok: true, text: '그대로' });
});

test('키가 없으면 안내 메시지와 함께 실패한다', async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const ai = createAi({ getKeys: () => ({}), getSettings: () => ({ customTones: [], polishModel: 'claude-opus-5-5', polishEffort: 'low' }) });
  const res = await ai.polish({ text: '안녕', toneId: 'formal' });
  assert.equal(res.ok, false);
  assert.match(res.error, /Anthropic API 키가 없습니다/);
  if (saved) process.env.ANTHROPIC_API_KEY = saved;
});
