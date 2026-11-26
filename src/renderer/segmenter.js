// 음량(RMS) 흐름을 보고 발화 구간을 나누는 순수 로직. 브라우저와 Node 테스트에서 함께 쓴다.
(function (root) {
  function createSegmenter(opts = {}) {
    const o = {
      silenceMs: 900, // 이만큼 조용하면 한 문장 묶음이 끝난 것으로 본다
      minSpeechMs: 250, // 이보다 짧은 소리는 잡음으로 본다
      maxSegmentMs: 30000, // 너무 긴 발화는 강제로 끊는다
      noSpeechWarnMs: 8000, // 이 시간 동안 소리가 없으면 경고
      minThreshold: 0.012,
      ...opts,
    };
    let noiseFloor = 0.005;
    let segStart = 0;
    let speechMs = 0;
    let lastSpeechAt = null;
    let lastVoiceAnyAt = 0;
    let warned = false;

    function threshold() {
      return Math.max(o.minThreshold, noiseFloor * 3);
    }

    function reset(now) {
      segStart = now;
      speechMs = 0;
      lastSpeechAt = null;
    }

    // 매 프레임 호출. 반환: { speaking, cut: null | 'silence' | 'max', warnNoSpeech }
    function push(rms, now, dt) {
      const isSpeech = rms > threshold();
      if (!isSpeech) {
        // 조용한 구간으로 배경 소음 수준을 천천히 추적한다.
        noiseFloor = noiseFloor * 0.98 + rms * 0.02;
      } else {
        speechMs += dt;
        lastSpeechAt = now;
        lastVoiceAnyAt = now;
        warned = false;
      }
      let cut = null;
      const hasSpeech = speechMs >= o.minSpeechMs;
      if (hasSpeech && lastSpeechAt !== null && now - lastSpeechAt >= o.silenceMs) cut = 'silence';
      else if (now - segStart >= o.maxSegmentMs) cut = 'max';

      let warnNoSpeech = false;
      if (!warned && now - lastVoiceAnyAt >= o.noSpeechWarnMs) {
        warned = true;
        warnNoSpeech = true;
      }
      return { speaking: isSpeech, cut, hasSpeech, warnNoSpeech };
    }

    function start(now) {
      reset(now);
      lastVoiceAnyAt = now;
      warned = false;
    }

    return {
      start,
      reset,
      push,
      hasSpeech: () => speechMs >= o.minSpeechMs,
      threshold,
      setSilenceMs: (ms) => (o.silenceMs = ms),
    };
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { createSegmenter };
  else root.createSegmenter = createSegmenter;
})(typeof window !== 'undefined' ? window : globalThis);
