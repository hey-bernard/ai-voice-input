/* 받아쓰기 창: 세션 상태, 문장 묶음 처리 흐름, 검토/수정, 삽입을 담당한다. */
(async function () {
  const $ = (id) => document.getElementById(id);
  const info = await window.api.info();
  const isMac = info.platform === 'darwin';
  const MOD = isMac ? '⌘' : 'Ctrl';
  let { settings } = await window.api.getSettings();

  const STATE_LABEL = {
    idle: '대기 중',
    recording: '녹음 중',
    paused: '일시정지',
    processing: '처리 중',
    stopped: '종료됨',
    error: '오류',
  };

  const session = {
    state: 'idle', // idle | recording | paused | stopped | error
    elapsedMs: 0,
    runningSince: null,
    bundles: [],
    seq: 0,
  };
  let recorder = null;
  let messages = []; // { id, kind, text, actions: [{label, fn}] }
  let msgSeq = 0;

  // ---------- 유틸 ----------
  function announce(text) {
    $('announcer').textContent = '';
    setTimeout(() => ($('announcer').textContent = text), 30);
  }
  function fmtTime(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }
  function elapsed() {
    return session.elapsedMs + (session.runningSince ? Date.now() - session.runningSince : 0);
  }
  function tones() {
    return [...info.builtinTones, ...(settings.customTones || []).map(({ id, name }) => ({ id, name }))];
  }
  function toneName(id) {
    return (tones().find((t) => t.id === id) || {}).name || '';
  }
  function langName(code) {
    return info.languages[code] || code;
  }
  function busy(b) {
    return b.status === 'transcribing' || b.status === 'polishing';
  }
  function anyBusy() {
    return session.bundles.some(busy);
  }
  function insertable(b) {
    return b.included && !b.inserted && (b.status === 'ready' || (b.status === 'error' && b.errorStage === 'polish')) && b.text.trim();
  }

  function addMessage(kind, text, actions = [], { key } = {}) {
    if (key) messages = messages.filter((m) => m.key !== key);
    const m = { id: ++msgSeq, kind, text, actions, key };
    messages.push(m);
    renderMessages();
    if (kind === 'ok') setTimeout(() => dismiss(m.id), 4000);
    return m.id;
  }
  function dismiss(id) {
    messages = messages.filter((m) => m.id !== id);
    renderMessages();
  }
  function dismissKey(key) {
    messages = messages.filter((m) => m.key !== key);
    renderMessages();
  }

  // ---------- 복구용 임시 저장 ----------
  let saveTimer = null;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const pending = session.bundles.filter((b) => !b.inserted && b.included && (b.text || b.raw));
      if (!pending.length) {
        window.api.clearRecovery();
        return;
      }
      window.api.saveRecovery({
        savedAt: new Date().toISOString(),
        bundles: pending.map(({ raw, polished, text, toneId, languages, edited }) => ({ raw, polished, text, toneId, languages, edited })),
      });
    }, 400);
  }

  // ---------- 세션 제어 ----------
  async function startRecording() {
    if (session.state === 'recording') return;
    const perm = await window.api.permStatus();
    if (perm.microphone === 'denied' || perm.microphone === 'restricted') {
      setState('error');
      addMessage('error', '마이크 권한이 거부되어 받아쓰기를 시작할 수 없습니다. 운영체제 설정에서 마이크 사용을 허용한 뒤 다시 시도하세요.', [
        { label: '설정 열기', fn: () => window.api.permOpenSettings('microphone') },
      ], { key: 'mic' });
      return;
    }
    if (perm.microphone === 'not-determined') await window.api.permRequest('microphone');
    const keys = (await window.api.getSettings()).keys;
    if (!keys.openai) {
      addMessage('error', '음성 인식에 필요한 OpenAI API 키가 없습니다.', [
        { label: 'API 키 입력', fn: () => window.api.openSettings('keys') },
      ], { key: 'keys' });
      return;
    }
    if (!keys.anthropic && settings.toneId !== 'raw') {
      addMessage('warn', 'Anthropic API 키가 없어 문장 다듬기 없이 원문으로 받아씁니다.', [
        { label: 'API 키 입력', fn: () => window.api.openSettings('keys') },
      ], { key: 'keys' });
    }

    dismissKey('mic');
    dismissKey('nospeech');
    recorder = window.createRecorder({
      silenceMs: settings.silenceMs,
      onSegment: handleSegment,
      onLevel: (rms, speaking) => {
        const pct = Math.min(100, Math.round(Math.sqrt(rms) * 220));
        $('meter').firstElementChild.style.width = pct + '%';
        $('meter').classList.toggle('speaking', speaking);
        if (speaking) dismissKey('nospeech');
      },
      onWarn: (text) => addMessage('warn', text, [
        { label: '마이크 설정', fn: () => window.api.openSettings('audio') },
      ], { key: 'nospeech' }),
      onError: (e) => {
        if (e.code === 'ended') stopRecording();
      },
    });
    try {
      await recorder.start(settings.micDeviceId);
    } catch (e) {
      recorder = null;
      setState('error');
      const actions = e.code === 'permission'
        ? [{ label: '설정 열기', fn: () => window.api.permOpenSettings('microphone') }]
        : [{ label: '다시 시도', fn: startRecording }];
      addMessage('error', e.message, actions, { key: 'mic' });
      return;
    }
    session.runningSince = Date.now();
    setState('recording');
    announce('녹음을 시작했습니다. 말씀하세요.');
  }

  async function pauseRecording() {
    if (session.state !== 'recording') return;
    await recorder.pause();
    recorder = null;
    session.elapsedMs = elapsed();
    session.runningSince = null;
    setState('paused');
    announce('일시정지했습니다.');
  }

  async function stopRecording() {
    if (session.state !== 'recording' && session.state !== 'paused') return;
    if (recorder) await recorder.stop();
    recorder = null;
    session.elapsedMs = elapsed();
    session.runningSince = null;
    setState('stopped');
    $('meter').firstElementChild.style.width = '0';
    announce('받아쓰기를 종료했습니다. 결과를 확인한 뒤 삽입하세요.');
  }

  function setState(state) {
    session.state = state;
    render();
  }

  // ---------- 문장 묶음 처리 ----------
  function newBundle(audio, durationMs) {
    const b = {
      id: 'b' + ++session.seq,
      seq: session.seq,
      status: 'transcribing',
      raw: '',
      polished: '',
      text: '',
      edited: false,
      included: true,
      inserted: false,
      showRaw: false,
      languages: [],
      languageUncertain: false,
      unsupported: [],
      error: '',
      errorStage: '',
      audio,
      mimeType: audio ? audio.type : '',
      durationMs,
      toneId: settings.toneId,
    };
    session.bundles.push(b);
    return b;
  }

  function handleSegment(blob, durationMs) {
    const b = newBundle(blob, durationMs);
    render();
    processBundle(b);
  }

  function previousBundles(b, n) {
    return session.bundles.filter((x) => x.seq < b.seq && x.text).slice(-n);
  }

  async function processBundle(b, { language } = {}) {
    b.status = 'transcribing';
    b.error = '';
    b.errorStage = '';
    render();
    const prev = previousBundles(b, 2).map((x) => x.raw).join(' ').slice(-300);
    const audio = await b.audio.arrayBuffer();
    const res = await window.api.transcribe({ audio, mimeType: b.mimeType, language, prompt: prev || undefined });
    if (!res.ok) {
      b.status = 'error';
      b.errorStage = 'transcribe';
      b.error = res.error;
      render();
      return;
    }
    b.raw = res.text;
    b.languages = res.languages;
    b.languageUncertain = res.languageUncertain;
    b.unsupported = res.unsupported;
    if (!b.raw) {
      b.status = 'empty';
      b.included = false;
      render();
      return;
    }
    if (!b.edited) b.text = b.raw;
    await polishBundle(b);
  }

  async function polishBundle(b) {
    b.toneId = settings.toneId;
    if (b.toneId === 'raw' || !(await window.api.getSettings()).keys.anthropic) {
      b.polished = '';
      if (!b.edited) b.text = b.raw;
      b.status = 'ready';
      render();
      persist();
      return;
    }
    b.status = 'polishing';
    render();
    const context = previousBundles(b, 2).map((x) => x.text);
    const res = await window.api.polish({ text: b.raw, toneId: b.toneId, context });
    if (!res.ok) {
      // 다듬기에 실패해도 원문은 보존하고 삽입할 수 있게 한다.
      b.status = 'error';
      b.errorStage = 'polish';
      b.error = res.error;
      if (!b.edited) b.text = b.raw;
    } else if (!res.text) {
      b.status = 'empty';
      b.included = false;
    } else {
      b.polished = res.text;
      if (!b.edited) b.text = res.text;
      b.status = 'ready';
    }
    render();
    persist();
  }

  function repolishAll() {
    for (const b of session.bundles) {
      if (!b.inserted && b.raw && !busy(b)) {
        b.edited = false;
        polishBundle(b);
      }
    }
  }

  // ---------- 삽입 ----------
  function joinTexts(list) {
    const sep = settings.insertSeparator === 'newline' ? '\n' : ' ';
    return list.map((b) => b.text.trim()).join(sep);
  }

  async function waitForProcessing(timeoutMs = 20000) {
    const t0 = Date.now();
    while (session.bundles.some((b) => b.included && busy(b)) && Date.now() - t0 < timeoutMs) {
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  async function insertBundles(list, { copyOnly = false } = {}) {
    if (!list.length) {
      addMessage('warn', '삽입할 문장이 없습니다. 포함할 문장 묶음을 선택하세요.');
      return;
    }
    const text = joinTexts(list);
    if (copyOnly) {
      await window.api.copy(text);
      addMessage('ok', `${list.length}개 문장 묶음을 클립보드에 복사했습니다.`);
      return;
    }
    const keepOpen = session.state === 'recording' || session.state === 'paused';
    const res = await window.api.insert({ text, keepOpen });
    if (res.ok) {
      list.forEach((b) => (b.inserted = true));
      announce(`${list.length}개 문장 묶음을 삽입했습니다.`);
      if (!keepOpen) clearInserted();
    } else {
      const actions = res.reason === 'permission'
        ? [{ label: '권한 설정 열기', fn: () => window.api.permRequest('accessibility').then(() => window.api.permOpenSettings('accessibility')) }]
        : [];
      if (res.copied) list.forEach((b) => (b.inserted = true));
      addMessage(res.copied ? 'warn' : 'error', res.message, actions);
    }
    render();
    persist();
  }

  async function insertSelected() {
    if (session.state === 'recording' || session.state === 'paused') await stopRecording();
    if (anyBusy()) {
      addMessage('info', '마지막 문장을 처리하는 중입니다…', [], { key: 'wait' });
      await waitForProcessing();
      dismissKey('wait');
    }
    const pendingIncluded = session.bundles.filter((b) => b.included && !b.inserted && busy(b));
    if (pendingIncluded.length) {
      addMessage('warn', `${pendingIncluded.length}개 문장 묶음이 아직 처리되지 않아 제외하고 삽입합니다.`);
    }
    const failed = session.bundles.filter((b) => b.included && !b.inserted && b.status === 'error' && b.errorStage === 'transcribe');
    if (failed.length) {
      addMessage('warn', `${failed.length}개 문장 묶음은 인식에 실패해 삽입하지 않았습니다. 다시 시도할 수 있습니다.`);
    }
    await insertBundles(session.bundles.filter(insertable));
  }

  function clearInserted() {
    session.bundles = session.bundles.filter((b) => !b.inserted && b.status !== 'empty');
    if (!session.bundles.length && session.state === 'stopped') {
      session.state = 'idle';
      session.elapsedMs = 0;
    }
  }

  function newSession() {
    session.bundles = [];
    session.elapsedMs = 0;
    session.state = 'idle';
    messages = [];
    window.api.clearRecovery();
    render();
    renderMessages();
  }

  // ---------- 렌더링 ----------
  function renderTones() {
    const el = $('tones');
    el.innerHTML = '';
    tones().forEach((t, i) => {
      const btn = document.createElement('button');
      btn.className = 'tone';
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', String(t.id === settings.toneId));
      btn.tabIndex = t.id === settings.toneId ? 0 : -1;
      btn.textContent = t.name;
      btn.title = i < 9 ? `Alt+${i + 1}` : '';
      btn.onclick = () => selectTone(t.id);
      btn.onkeydown = (e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          const list = tones();
          const next = list[(i + (e.key === 'ArrowRight' ? 1 : list.length - 1)) % list.length];
          selectTone(next.id);
          setTimeout(() => el.querySelector('[aria-checked="true"]')?.focus(), 0);
        }
      };
      el.appendChild(btn);
    });
    const spacer = document.createElement('span');
    spacer.className = 'spacer';
    el.appendChild(spacer);
    const canRepolish = session.bundles.some((b) => !b.inserted && b.raw && b.toneId !== settings.toneId);
    if (canRepolish) {
      const re = document.createElement('button');
      re.className = 'btn small';
      re.textContent = '이 말투로 다시 다듬기';
      re.onclick = repolishAll;
      el.appendChild(re);
    }
  }

  async function selectTone(id) {
    settings = (await window.api.setSettings({ toneId: id })).settings;
    announce(`말투: ${toneName(id)}`);
    renderTones();
  }

  function renderMessages() {
    const el = $('messages');
    el.innerHTML = '';
    for (const m of messages) {
      const div = document.createElement('div');
      div.className = `msg ${m.kind}`;
      div.setAttribute('role', m.kind === 'error' ? 'alert' : 'status');
      const t = document.createElement('span');
      t.className = 'text';
      t.textContent = m.text;
      div.appendChild(t);
      const actions = document.createElement('span');
      actions.className = 'actions';
      for (const a of m.actions) {
        const b = document.createElement('button');
        b.className = 'btn small';
        b.textContent = a.label;
        b.onclick = a.fn;
        actions.appendChild(b);
      }
      const close = document.createElement('button');
      close.className = 'btn small ghost';
      close.textContent = '닫기';
      close.setAttribute('aria-label', '알림 닫기');
      close.onclick = () => dismiss(m.id);
      actions.appendChild(close);
      div.appendChild(actions);
      el.appendChild(div);
    }
  }

  function statusBadge(b) {
    if (b.inserted) return ['ok', '삽입됨'];
    switch (b.status) {
      case 'transcribing': return ['busy', '인식 중…'];
      case 'polishing': return ['busy', '다듬는 중…'];
      case 'ready': return b.edited ? ['', '수정됨'] : ['ok', b.polished ? toneName(b.toneId) : '원문'];
      case 'empty': return ['', '말소리 없음'];
      case 'error': return ['err', b.errorStage === 'transcribe' ? '인식 실패' : '다듬기 실패 · 원문'];
      default: return ['', ''];
    }
  }

  function renderBundle(b) {
    const card = document.createElement('section');
    card.className = 'bundle' + (b.included ? '' : ' excluded') + (b.inserted ? ' inserted' : '');
    card.setAttribute('aria-label', `문장 묶음 ${b.seq}`);

    const top = document.createElement('div');
    top.className = 'top';
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = b.included;
    cb.disabled = b.inserted || b.status === 'empty';
    cb.setAttribute('aria-label', `문장 묶음 ${b.seq} 삽입에 포함`);
    cb.onchange = () => {
      b.included = cb.checked;
      render();
      persist();
    };
    label.append(cb, document.createTextNode(`#${b.seq}`));
    top.appendChild(label);
    const [cls, text] = statusBadge(b);
    const badge = document.createElement('span');
    badge.className = 'badge ' + cls;
    badge.textContent = text;
    top.appendChild(badge);
    if (b.languages.length) {
      const lb = document.createElement('span');
      lb.className = 'badge' + (b.unsupported.length ? ' warn' : '');
      lb.textContent = b.languages.map(langName).join(' · ');
      top.appendChild(lb);
    }
    if (b.languageUncertain) {
      const lb = document.createElement('span');
      lb.className = 'badge warn';
      lb.textContent = '언어 불확실';
      top.appendChild(lb);
    }
    const grow = document.createElement('span');
    grow.className = 'grow';
    top.appendChild(grow);
    if (b.durationMs) {
      const d = document.createElement('span');
      d.textContent = `${Math.max(1, Math.round(b.durationMs / 1000))}초`;
      top.appendChild(d);
    }
    card.appendChild(top);

    if (b.status === 'transcribing' && !b.raw) {
      const p = document.createElement('div');
      p.className = 'placeholder';
      p.textContent = '음성을 텍스트로 바꾸는 중…';
      card.appendChild(p);
    } else if (b.status === 'error' && b.errorStage === 'transcribe') {
      const p = document.createElement('div');
      p.className = 'placeholder';
      p.textContent = b.error;
      card.appendChild(p);
    } else if (b.status !== 'empty') {
      const ta = document.createElement('textarea');
      ta.value = b.text;
      ta.rows = Math.min(8, Math.max(2, Math.ceil(b.text.length / 48)));
      ta.readOnly = b.inserted;
      ta.setAttribute('aria-label', `문장 묶음 ${b.seq} 내용 편집`);
      ta.oninput = () => {
        b.text = ta.value;
        b.edited = true;
        // 입력 중에는 목록을 다시 그리지 않는다(다시 그리면 바로 이어지는 클릭이 사라진다).
        const [c, t] = statusBadge(b);
        badge.className = 'badge ' + c;
        badge.textContent = t;
        renderFooter();
        persist();
      };
      card.appendChild(ta);
      if (b.showRaw && b.raw && b.raw !== b.text) {
        const raw = document.createElement('div');
        raw.className = 'raw';
        raw.textContent = '원문: ' + b.raw;
        card.appendChild(raw);
      }
    }

    if (b.status === 'error' && b.errorStage === 'polish') {
      const p = document.createElement('div');
      p.className = 'raw';
      p.textContent = `${b.error} 원문은 그대로 삽입할 수 있습니다.`;
      card.appendChild(p);
    }

    if (!b.inserted) {
      const row = document.createElement('div');
      row.className = 'row';
      const add = (label, fn, aria) => {
        const btn = document.createElement('button');
        btn.className = 'btn small';
        btn.textContent = label;
        if (aria) btn.setAttribute('aria-label', aria);
        btn.onclick = fn;
        row.appendChild(btn);
        return btn;
      };
      if (b.status === 'error') {
        add('다시 시도', () => (b.errorStage === 'transcribe' ? processBundle(b) : polishBundle(b)), `문장 묶음 ${b.seq} 다시 시도`);
      }
      if (b.raw && b.polished) {
        add(b.showRaw ? '원문 숨기기' : '원문 보기', () => { b.showRaw = !b.showRaw; render(); });
      }
      if (b.edited && (b.polished || b.raw)) {
        add('수정 취소', () => { b.text = b.polished || b.raw; b.edited = false; render(); persist(); });
      }
      if (b.raw && (b.languageUncertain || b.unsupported.length)) {
        const sel = document.createElement('select');
        sel.setAttribute('aria-label', `문장 묶음 ${b.seq} 언어 선택 후 다시 인식`);
        const opt0 = document.createElement('option');
        opt0.textContent = '언어 지정해 다시 인식…';
        opt0.value = '';
        sel.appendChild(opt0);
        for (const [code, name] of Object.entries(info.languages)) {
          const o = document.createElement('option');
          o.value = code;
          o.textContent = name;
          sel.appendChild(o);
        }
        sel.onchange = () => sel.value && processBundle(b, { language: sel.value });
        row.appendChild(sel);
        if (b.unsupported.length) {
          const note = document.createElement('span');
          note.style.fontSize = '12px';
          note.style.color = 'var(--warn)';
          note.textContent = `지원하지 않는 언어(${b.unsupported.join(', ')})가 감지되었습니다. 대체 언어: ${langName(settings.fallbackLanguage)}`;
          row.appendChild(note);
        }
      }
      if (insertable(b)) add('이것만 삽입', () => insertBundles([b]), `문장 묶음 ${b.seq}만 삽입`);
      if (b.status !== 'empty') {
        add(b.included ? '제외' : '포함', () => { b.included = !b.included; render(); persist(); });
      }
      card.appendChild(row);
    }
    return card;
  }

  function render() {
    const processing = anyBusy() && (session.state === 'stopped' || session.state === 'idle');
    const shown = processing ? 'processing' : session.state;
    $('status').dataset.state = shown;
    $('statusText').textContent = STATE_LABEL[shown];
    $('elapsed').textContent = fmtTime(elapsed());

    const recBtn = $('btnRecord');
    if (session.state === 'recording') recBtn.textContent = '❚❚ 일시정지';
    else if (session.state === 'paused') recBtn.textContent = '● 이어서 받아쓰기';
    else recBtn.textContent = session.bundles.length ? '● 이어서 받아쓰기' : '● 받아쓰기 시작';
    recBtn.setAttribute('aria-keyshortcuts', 'Alt+P');
    $('btnStop').disabled = !(session.state === 'recording' || session.state === 'paused');

    renderFooter();
    renderList();
  }

  function renderFooter() {
    const ready = session.bundles.filter(insertable);
    $('btnInsert').disabled = !ready.length && !session.bundles.some((b) => b.included && busy(b));
    $('btnInsert').textContent = ready.length ? `삽입 (${ready.length})` : '삽입';
    $('btnCopy').disabled = !ready.length;
  }

  function renderList() {
    const list = $('list');
    const active = document.activeElement;
    const focusKey = active && active.closest('.bundle') ? active.getAttribute('aria-label') : null;
    const sel = active && active.tagName === 'TEXTAREA' ? [active.selectionStart, active.selectionEnd, active.scrollTop] : null;
    const scrolledToBottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 30;
    list.innerHTML = '';
    if (!session.bundles.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.innerHTML = session.state === 'recording'
        ? '<strong>듣고 있어요</strong>말을 멈추면 문장 묶음으로 정리됩니다.'
        : '<strong>말로 입력하세요</strong>시작하면 말한 내용을 문장 묶음으로 나눠 다듬고, 확정하면 쓰던 앱의 커서 위치에 넣어 드립니다.';
      list.appendChild(e);
    } else {
      const visible = session.bundles.filter((b) => b.status !== 'empty' || !b.inserted);
      visible.forEach((b) => list.appendChild(renderBundle(b)));
      if (visible.some((b) => b.inserted)) {
        const c = document.createElement('button');
        c.className = 'btn small ghost';
        c.textContent = '삽입한 항목 정리';
        c.onclick = () => { clearInserted(); render(); };
        list.appendChild(c);
      }
      if (session.state === 'stopped' || session.state === 'idle') {
        const n = document.createElement('button');
        n.className = 'btn small ghost danger';
        n.textContent = '모두 지우고 새로 시작';
        n.onclick = newSession;
        list.appendChild(n);
      }
    }
    if (focusKey) {
      const el = list.querySelector(`[aria-label="${focusKey}"]`);
      if (el) {
        el.focus();
        if (sel && el.tagName === 'TEXTAREA') {
          el.setSelectionRange(sel[0], sel[1]);
          el.scrollTop = sel[2];
        }
      }
    }
    if (scrolledToBottom && session.state === 'recording') list.scrollTop = list.scrollHeight;
    renderTones();
  }

  function renderHints() {
    const s = settings.shortcuts;
    const pretty = (a) => (a || '').replace('CommandOrControl', MOD).replace(/\+/g, ' + ');
    $('hints').innerHTML = '';
    const items = [
      [pretty(s.toggle), '시작/종료'],
      [pretty(s.insert), '바로 삽입'],
      [`${MOD} + Enter`, '삽입'],
      ['Alt + P', '일시정지'],
      ['Alt + 1~9', '말투'],
      ['Esc', '숨기기'],
    ];
    for (const [k, label] of items) {
      if (!k) continue;
      const span = document.createElement('span');
      const kbd = document.createElement('kbd');
      kbd.textContent = k;
      span.append(kbd, ' ' + label);
      $('hints').appendChild(span);
    }
  }

  // ---------- 이벤트 ----------
  $('btnRecord').onclick = () => {
    if (session.state === 'recording') pauseRecording();
    else startRecording();
  };
  $('btnStop').onclick = stopRecording;
  $('btnInsert').onclick = insertSelected;
  $('btnCopy').onclick = () => insertBundles(session.bundles.filter(insertable), { copyOnly: true });
  $('btnHide').onclick = () => window.api.hide();
  $('btnSettings').onclick = () => window.api.openSettings();

  document.addEventListener('keydown', (e) => {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (mod && e.key === 'Enter') {
      e.preventDefault();
      insertSelected();
    } else if (e.altKey && (e.code === 'KeyP')) {
      e.preventDefault();
      $('btnRecord').click();
    } else if (e.altKey && e.code === 'KeyS') {
      e.preventDefault();
      stopRecording();
    } else if (e.altKey && /^Digit[1-9]$/.test(e.code)) {
      const t = tones()[Number(e.code.slice(5)) - 1];
      if (t) {
        e.preventDefault();
        selectTone(t.id);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      window.api.hide();
    }
  });

  window.api.on('hotkey', async (kind) => {
    if (kind === 'toggle') {
      if (session.state === 'recording' || session.state === 'paused') await stopRecording();
      else await startRecording();
    } else if (kind === 'insert') {
      await insertSelected();
    }
  });
  window.api.on('settings:changed', (s) => {
    settings = s;
    renderHints();
    render();
  });
  window.api.on('data:deleted', () => {
    addMessage('ok', '보관된 받아쓰기 데이터를 삭제했습니다.');
  });

  setInterval(() => {
    if (session.runningSince) $('elapsed').textContent = fmtTime(elapsed());
  }, 250);

  // 이전에 비정상 종료된 세션이 있으면 복구를 제안한다.
  const recovery = await window.api.loadRecovery();
  if (recovery && recovery.bundles && recovery.bundles.length) {
    addMessage('info', `이전에 삽입하지 않은 문장 묶음 ${recovery.bundles.length}개가 있습니다.`, [
      {
        label: '복구',
        fn: () => {
          for (const r of recovery.bundles) {
            const b = newBundle(null, 0);
            Object.assign(b, r, { status: 'ready' });
          }
          session.state = 'stopped';
          dismissKey('recovery');
          render();
        },
      },
      { label: '버리기', fn: () => { window.api.clearRecovery(); dismissKey('recovery'); } },
    ], { key: 'recovery' });
  }

  renderHints();
  render();

  // 테스트와 디버깅용 훅
  window.__voice = { session, handleSegment, render, insertSelected, startRecording, stopRecording };
})();
