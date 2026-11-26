const test = require('node:test');
const assert = require('node:assert');
const { createSegmenter } = require('../src/renderer/segmenter.js');

function feed(seg, frames, t0 = 0, dt = 50) {
  let t = t0;
  const out = [];
  for (const rms of frames) {
    t += dt;
    out.push({ t, ...seg.push(rms, t, dt) });
  }
  return out;
}
const quiet = (n) => Array(n).fill(0.002);
const loud = (n) => Array(n).fill(0.08);

test('말한 뒤 침묵이 이어지면 silence 로 구간을 끊는다', () => {
  const seg = createSegmenter({ silenceMs: 900 });
  seg.start(0);
  const out = feed(seg, [...quiet(10), ...loud(20), ...quiet(25)]);
  const cut = out.find((o) => o.cut);
  assert.ok(cut, '구간이 끊겨야 한다');
  assert.equal(cut.cut, 'silence');
  // 마지막 발화(1500ms) + 침묵 900ms 근처에서 끊긴다
  assert.ok(cut.t >= 1500 + 900 && cut.t <= 1500 + 1000, `cut at ${cut.t}`);
});

test('짧은 잡음만 있으면 구간을 끊지 않는다', () => {
  const seg = createSegmenter({ silenceMs: 900, minSpeechMs: 250 });
  seg.start(0);
  const out = feed(seg, [...loud(2), ...quiet(40)]);
  assert.ok(!out.some((o) => o.cut === 'silence'));
  assert.equal(seg.hasSpeech(), false);
});

test('너무 긴 발화는 최대 길이에서 강제로 끊는다', () => {
  const seg = createSegmenter({ maxSegmentMs: 3000 });
  seg.start(0);
  const out = feed(seg, loud(80));
  assert.equal(out.find((o) => o.cut).cut, 'max');
});

test('오랫동안 소리가 없으면 한 번만 경고한다', () => {
  const seg = createSegmenter({ noSpeechWarnMs: 2000 });
  seg.start(0);
  const out = feed(seg, quiet(100));
  assert.equal(out.filter((o) => o.warnNoSpeech).length, 1);
});

test('reset 후에는 새 구간으로 다시 센다', () => {
  const seg = createSegmenter({ silenceMs: 500 });
  seg.start(0);
  feed(seg, loud(10));
  seg.reset(500);
  assert.equal(seg.hasSpeech(), false);
});
