// 마이크를 열고, 침묵을 기준으로 발화를 문장 묶음 단위 오디오 조각으로 잘라 넘긴다.
(function () {
  const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4'];

  function pickMime() {
    return MIME_CANDIDATES.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
  }

  function micErrorMessage(err) {
    switch (err && err.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return { code: 'permission', message: '마이크 권한이 없습니다. 운영체제 설정에서 이 앱의 마이크 사용을 허용하세요.' };
      case 'NotFoundError':
      case 'OverconstrainedError':
        return { code: 'no-device', message: '사용할 수 있는 마이크를 찾지 못했습니다. 마이크 연결과 설정의 마이크 선택을 확인하세요.' };
      case 'NotReadableError':
        return { code: 'busy', message: '다른 프로그램이 마이크를 사용 중이라 열 수 없습니다.' };
      default:
        return { code: 'unknown', message: `마이크를 열지 못했습니다: ${(err && err.message) || err}` };
    }
  }

  function createRecorder(opts) {
    const { onSegment, onLevel, onWarn, onError } = opts;
    let stream = null;
    let ctx = null;
    let analyser = null;
    let timer = null;
    let rec = null;
    let segStartedAt = 0;
    let lastTick = 0;
    const mime = pickMime();
    const seg = window.createSegmenter({ silenceMs: opts.silenceMs || 900 });
    const buf = new Float32Array(2048);

    function newRecorder() {
      const r = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const myChunks = [];
      r.ondataavailable = (e) => e.data && e.data.size && myChunks.push(e.data);
      r.start();
      r._chunks = myChunks;
      return r;
    }

    // 현재 조각을 마무리한다. 말소리가 있었던 조각만 결과로 넘긴다.
    function finishSegment(reason, { restart }) {
      const old = rec;
      const hadSpeech = seg.hasSpeech();
      const durationMs = performance.now() - segStartedAt;
      if (restart) {
        rec = newRecorder();
        segStartedAt = performance.now();
        seg.reset(segStartedAt);
      } else {
        rec = null;
      }
      if (!old) return Promise.resolve();
      return new Promise((resolve) => {
        old.onstop = () => {
          if (hadSpeech) {
            const blob = new Blob(old._chunks, { type: old.mimeType || mime || 'audio/webm' });
            onSegment(blob, durationMs, reason);
          }
          resolve();
        };
        old.stop();
      });
    }

    function tick() {
      if (!analyser || !rec) return;
      const now = performance.now();
      const dt = now - lastTick;
      lastTick = now;
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const rms = Math.sqrt(sum / buf.length);
      const r = seg.push(rms, now, dt);
      onLevel && onLevel(rms, r.speaking);
      if (r.warnNoSpeech) onWarn && onWarn('음성이 감지되지 않습니다. 마이크가 켜져 있는지, 올바른 마이크가 선택되었는지 확인하세요.');
      if (r.cut) finishSegment(r.cut, { restart: true });
    }

    async function open(deviceId) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            deviceId: deviceId ? { exact: deviceId } : undefined,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
          },
        });
      } catch (err) {
        const e = micErrorMessage(err);
        onError && onError(e);
        throw e;
      }
      ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      src.connect(analyser);
      stream.getAudioTracks()[0].addEventListener('ended', () => {
        onError && onError({ code: 'ended', message: '마이크 연결이 끊어졌습니다. 마이크를 확인한 뒤 다시 시작하세요.' });
      });
    }

    function close() {
      clearInterval(timer);
      timer = null;
      if (stream) stream.getTracks().forEach((t) => t.stop());
      if (ctx) ctx.close();
      stream = ctx = analyser = null;
    }

    return {
      mime,
      async start(deviceId) {
        await open(deviceId);
        segStartedAt = lastTick = performance.now();
        seg.start(segStartedAt);
        rec = newRecorder();
        timer = setInterval(tick, 50);
      },
      // 일시정지: 지금까지 말한 부분은 결과로 넘기고 마이크를 해제한다.
      async pause() {
        await finishSegment('pause', { restart: false });
        close();
      },
      async stop() {
        await finishSegment('stop', { restart: false });
        close();
      },
      setSilenceMs: (ms) => seg.setSilenceMs(ms),
      get active() {
        return Boolean(rec);
      },
    };
  }

  window.createRecorder = createRecorder;
})();
