(async function () {
  const $ = (id) => document.getElementById(id);
  const info = await window.api.info();
  const isMac = info.platform === 'darwin';
  let state = await window.api.getSettings();
  let settings = state.settings;
  const DEFAULT_SHORTCUTS = { toggle: 'CommandOrControl+Shift+Space', insert: 'CommandOrControl+Shift+Enter' };

  // ---------- 탭 ----------
  const tabs = [...document.querySelectorAll('[role=tab]')];
  function showTab(name) {
    if (!document.getElementById('tab-' + name)) name = 'welcome';
    for (const t of tabs) {
      const on = t.dataset.tab === name;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      $('tab-' + t.dataset.tab).hidden = !on;
    }
    if (name === 'welcome') refreshWelcome();
    if (name === 'data') refreshData();
    if (name === 'audio') refreshMics();
  }
  tabs.forEach((t, i) => {
    t.onclick = () => showTab(t.dataset.tab);
    t.onkeydown = (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = tabs[(i + (e.key === 'ArrowDown' ? 1 : tabs.length - 1)) % tabs.length];
        showTab(n.dataset.tab);
        n.focus();
      }
    };
  });
  document.querySelectorAll('[data-goto]').forEach((b) => (b.onclick = () => showTab(b.dataset.goto)));
  window.api.on('settings:tab', showTab);

  async function save(patch) {
    const res = await window.api.setSettings(patch);
    settings = res.settings;
    state.shortcutErrors = res.shortcutErrors;
    return res;
  }

  // ---------- 일반 설정 바인딩 ----------
  function fillSelect(sel, entries) {
    sel.innerHTML = '';
    for (const [v, label] of entries) {
      const o = document.createElement('option');
      o.value = v;
      o.textContent = label;
      sel.appendChild(o);
    }
  }
  fillSelect($('languageMode'), [['auto', '자동 감지 (다국어)'], ...Object.entries(info.languages).map(([c, n]) => [c, `${n}로 고정`])]);
  fillSelect($('fallbackLanguage'), Object.entries(info.languages));

  function bindSettings() {
    document.querySelectorAll('[data-setting]').forEach((el) => {
      const key = el.dataset.setting;
      if ('bool' in el.dataset) el.checked = Boolean(settings[key]);
      else el.value = String(settings[key] ?? '');
      el.onchange = async () => {
        const v = 'bool' in el.dataset ? el.checked : 'number' in el.dataset ? Number(el.value) : el.value;
        await save({ [key]: v });
        if (key === 'saveHistory') refreshData();
      };
    });
  }

  // ---------- 언어 ----------
  function renderLangChecks() {
    const box = $('langChecks');
    box.innerHTML = '';
    for (const [code, name] of Object.entries(info.languages)) {
      const label = document.createElement('label');
      label.className = 'checkbox';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = settings.languages.includes(code);
      cb.onchange = () => {
        const langs = Object.keys(info.languages).filter((c) => (c === code ? cb.checked : settings.languages.includes(c)));
        save({ languages: langs });
      };
      label.append(cb, document.createTextNode(name));
      box.appendChild(label);
    }
  }

  // ---------- API 키 ----------
  function renderKeyStatus(keys) {
    for (const [name, id] of [['openai', 'stOpenai'], ['anthropic', 'stAnthropic']]) {
      $(id).className = 'pill ' + (keys[name] ? 'ok' : 'bad');
      $(id).textContent = keys[name] ? '저장됨' : '없음';
    }
    $('encNote').textContent = keys.encrypted ? '' : ' (이 시스템에서는 암호화 저장소를 쓸 수 없어 일반 파일로 저장됩니다.)';
  }
  document.querySelectorAll('[data-save-key]').forEach((b) => {
    b.onclick = async () => {
      const name = b.dataset.saveKey;
      const input = name === 'openai' ? $('keyOpenai') : $('keyAnthropic');
      state.keys = await window.api.setKey(name, input.value);
      input.value = '';
      renderKeyStatus(state.keys);
    };
  });

  // ---------- 단축키 ----------
  function accelFromEvent(e) {
    const ignore = ['Control', 'Shift', 'Alt', 'Meta', 'OS'];
    if (ignore.includes(e.key)) return null;
    const parts = [];
    if (isMac ? e.metaKey : e.ctrlKey) parts.push('CommandOrControl');
    if (isMac && e.ctrlKey) parts.push('Control');
    if (!isMac && e.metaKey) parts.push('Super');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    let key = e.code;
    if (/^Key[A-Z]$/.test(key)) key = key.slice(3);
    else if (/^Digit\d$/.test(key)) key = key.slice(5);
    else if (/^F\d{1,2}$/.test(key)) key = key;
    else {
      const map = { Space: 'Space', Enter: 'Enter', Backquote: '`', Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\', Tab: 'Tab', Backspace: 'Backspace', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' };
      key = map[key];
      if (!key) return { error: '이 키는 단축키로 쓸 수 없습니다.' };
    }
    const hasModifier = parts.length > 0;
    if (!hasModifier && !/^F\d{1,2}$/.test(key)) return { error: '다른 앱 입력과 겹치지 않도록 Ctrl·Alt·Shift 같은 보조키를 함께 누르세요.' };
    return { accel: [...parts, key].join('+') };
  }
  function prettyAccel(a) {
    if (!a) return '없음';
    return a.replace('CommandOrControl', isMac ? '⌘' : 'Ctrl').replace('Control', '⌃').replace(/\+/g, ' + ');
  }
  function renderShortcuts() {
    for (const [kind, id] of [['toggle', 'scToggle'], ['insert', 'scInsert']]) {
      $(id).value = prettyAccel(settings.shortcuts[kind]);
      const err = state.shortcutErrors?.[kind];
      $(id + 'Result').className = 'result ' + (err ? 'err' : '');
      $(id + 'Result').textContent = err || '';
    }
    const mod = isMac ? '⌘' : 'Ctrl';
    $('localKeys').textContent = `${mod}+Enter 삽입 · Alt+P 일시정지/재개 · Alt+S 종료 · Alt+1~9 말투 선택 · Esc 창 숨기기 · Tab으로 모든 버튼 이동`;
  }
  document.querySelectorAll('[data-shortcut]').forEach((input) => {
    const kind = input.dataset.shortcut;
    const resultEl = $(input.id + 'Result');
    let capturing = false;
    const begin = () => {
      capturing = true;
      input.classList.add('recording');
      input.value = '키 조합을 누르세요… (Esc 취소)';
      window.api.suspendShortcuts(true);
    };
    const end = () => {
      capturing = false;
      input.classList.remove('recording');
      window.api.suspendShortcuts(false);
      renderShortcuts();
    };
    input.onclick = begin;
    input.onkeydown = async (e) => {
      if (!capturing) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); begin(); }
        return;
      }
      e.preventDefault();
      if (e.key === 'Escape') return end();
      const r = accelFromEvent(e);
      if (!r) return;
      if (r.error) {
        resultEl.className = 'result err';
        resultEl.textContent = r.error;
        return;
      }
      const other = kind === 'toggle' ? 'insert' : 'toggle';
      if (settings.shortcuts[other] === r.accel) {
        resultEl.className = 'result err';
        resultEl.textContent = '다른 동작에 이미 지정된 단축키입니다.';
        return;
      }
      capturing = false;
      input.classList.remove('recording');
      await save({ shortcuts: { ...settings.shortcuts, [kind]: r.accel } });
      renderShortcuts();
      if (!state.shortcutErrors?.[kind]) {
        resultEl.className = 'result ok';
        resultEl.textContent = `${prettyAccel(r.accel)}(으)로 변경했습니다.`;
      }
    };
    input.onblur = () => capturing && end();
  });
  document.querySelectorAll('[data-reset-shortcut]').forEach((b) => {
    b.onclick = async () => {
      const kind = b.dataset.resetShortcut;
      await save({ shortcuts: { ...settings.shortcuts, [kind]: DEFAULT_SHORTCUTS[kind] } });
      renderShortcuts();
    };
  });

  // ---------- 맞춤 말투 ----------
  function renderTones() {
    const box = $('customTones');
    box.innerHTML = '';
    for (const t of settings.customTones) {
      const card = document.createElement('div');
      card.className = 'card tone-item';
      const name = document.createElement('input');
      name.type = 'text';
      name.value = t.name;
      name.maxLength = 30;
      name.setAttribute('aria-label', '맞춤 스타일 이름');
      const inst = document.createElement('textarea');
      inst.rows = 2;
      inst.value = t.instruction;
      inst.maxLength = 600;
      inst.setAttribute('aria-label', `${t.name} 스타일 설명`);
      [name, inst].forEach((el) => { el.style.cssText = 'border:1px solid var(--border);border-radius:8px;background:var(--bg);padding:7px 10px'; });
      const row = document.createElement('div');
      row.className = 'inline';
      const saveBtn = document.createElement('button');
      saveBtn.className = 'btn';
      saveBtn.textContent = '저장';
      saveBtn.onclick = async () => {
        if (!name.value.trim() || !inst.value.trim()) return;
        await save({ customTones: settings.customTones.map((x) => (x.id === t.id ? { ...x, name: name.value.trim(), instruction: inst.value.trim() } : x)) });
        renderTones();
      };
      const del = document.createElement('button');
      del.className = 'btn danger';
      del.textContent = '삭제';
      del.onclick = async () => {
        const patch = { customTones: settings.customTones.filter((x) => x.id !== t.id) };
        if (settings.toneId === t.id) patch.toneId = 'formal';
        await save(patch);
        renderTones();
      };
      row.append(saveBtn, del);
      card.append(name, inst, row);
      box.appendChild(card);
    }
  }
  $('btnAddTone').onclick = async () => {
    const name = $('newToneName').value.trim();
    const instruction = $('newToneInst').value.trim();
    if (!name || !instruction) {
      $('toneResult').className = 'result err';
      $('toneResult').textContent = '이름과 스타일 설명을 모두 입력하세요.';
      return;
    }
    const id = 'custom-' + Date.now().toString(36);
    await save({ customTones: [...settings.customTones, { id, name, instruction }], toneId: id });
    $('newToneName').value = '';
    $('newToneInst').value = '';
    $('toneResult').className = 'result ok';
    $('toneResult').textContent = `‘${name}’ 스타일을 추가하고 현재 말투로 선택했습니다.`;
    renderTones();
  };

  // ---------- 마이크 ----------
  async function refreshMics() {
    const sel = $('micDeviceId');
    let devices = [];
    try {
      devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    } catch {}
    fillSelect(sel, [['', '시스템 기본 마이크'], ...devices.filter((d) => d.deviceId !== 'default').map((d, i) => [d.deviceId, d.label || `마이크 ${i + 1}`])]);
    sel.value = settings.micDeviceId || '';
  }

  // ---------- 권한·시작하기 ----------
  async function refreshWelcome() {
    state = await window.api.getSettings();
    settings = state.settings;
    $('privacyAccept').checked = settings.privacyAccepted;
    window.api.dataSummary().then((d) => ($('welcomeDir').textContent = `(${d.dataDir})`));
    $('privacyPill').className = 'pill ' + (settings.privacyAccepted ? 'ok' : 'warn');
    $('privacyPill').textContent = settings.privacyAccepted ? '확인함' : '확인 필요';

    const p = await window.api.permStatus();
    $('axLabel').textContent = isMac ? '손쉬운 사용' : '키 입력 전송';
    const list = $('permList');
    list.innerHTML = '';
    const rows = [
      {
        name: '마이크',
        ok: p.microphone === 'granted',
        status: { granted: '허용됨', denied: '거부됨', restricted: '제한됨', 'not-determined': '아직 묻지 않음', unknown: '알 수 없음' }[p.microphone] || p.microphone,
        limit: '받아쓰기를 시작할 수 없습니다.',
        request: () => window.api.permRequest('microphone'),
        kind: 'microphone',
      },
    ];
    if (p.accessibilityRequired) {
      rows.push({
        name: '손쉬운 사용',
        ok: p.accessibility,
        status: p.accessibility ? '허용됨' : '허용 필요',
        limit: '다른 앱에 자동으로 입력하지 못하고 클립보드 복사만 됩니다.',
        request: () => window.api.permRequest('accessibility'),
        kind: 'accessibility',
      });
    }
    for (const r of rows) {
      const div = document.createElement('div');
      div.className = 'inline';
      div.style.marginBottom = '8px';
      const pill = document.createElement('span');
      pill.className = 'pill ' + (r.ok ? 'ok' : 'bad');
      pill.textContent = r.status;
      const label = document.createElement('strong');
      label.textContent = r.name;
      div.append(label, pill);
      if (!r.ok) {
        const b1 = document.createElement('button');
        b1.className = 'btn small';
        b1.textContent = '권한 요청';
        b1.onclick = async () => { await r.request(); setTimeout(refreshWelcome, 500); };
        const b2 = document.createElement('button');
        b2.className = 'btn small';
        b2.textContent = '설정 열기';
        b2.onclick = () => window.api.permOpenSettings(r.kind);
        const note = document.createElement('span');
        note.className = 'help';
        note.style.fontSize = '12px';
        note.style.color = 'var(--fg-muted)';
        note.textContent = `허용하지 않으면 ${r.limit}`;
        div.append(b1, b2, note);
      }
      list.appendChild(div);
    }
    const allOk = rows.every((r) => r.ok);
    $('permPill').className = 'pill ' + (allOk ? 'ok' : 'warn');
    $('permPill').textContent = allOk ? '준비됨' : '확인 필요';
    if (info.platform === 'win32' || info.platform === 'linux') {
      const note = document.createElement('p');
      note.textContent = info.platform === 'win32'
        ? 'Windows에서는 별도 권한 없이 붙여넣기 키를 보냅니다. 관리자 권한으로 실행 중인 앱에는 입력되지 않을 수 있으며, 이때는 클립보드에 복사됩니다.'
        : 'Linux에서는 xdotool이 설치되어 있어야 다른 앱에 자동 입력됩니다.';
      list.appendChild(note);
    }

    const keysOk = state.keys.openai && state.keys.anthropic;
    $('keyPill').className = 'pill ' + (keysOk ? 'ok' : state.keys.openai ? 'warn' : 'bad');
    $('keyPill').textContent = keysOk ? '준비됨' : state.keys.openai ? '다듬기 키 없음' : '필요';
  }
  $('privacyAccept').onchange = async () => {
    await save({ privacyAccepted: $('privacyAccept').checked });
    refreshWelcome();
  };
  $('btnFinish').onclick = async () => {
    if (!settings.privacyAccepted) {
      $('finishResult').className = 'result err';
      $('finishResult').textContent = '음성과 텍스트 처리 방식을 확인하고 체크해야 사용할 수 있습니다.';
      $('privacyAccept').focus();
      return;
    }
    if (!state.keys.openai) {
      $('finishResult').className = 'result err';
      $('finishResult').textContent = '음성 인식에 필요한 OpenAI API 키를 먼저 입력하세요.';
      return;
    }
    window.api.onboardingDone();
  };

  // ---------- 데이터 ----------
  function showDir(d, okText) {
    $('dataDir').value = d.wantedDir;
    const r = $('dirResult');
    if (d.problem) {
      r.className = 'result err';
      r.textContent = d.problem;
    } else {
      r.className = 'result ' + (okText ? 'ok' : '');
      r.textContent = okText || `현재 저장 위치: ${d.dataDir}`;
    }
  }
  async function refreshData() {
    const d = await window.api.dataSummary();
    showDir(d);
    $('dataSummary').textContent = `저장 폴더: ${d.dataDir} · 삽입 기록 ${d.historyCount}건 · 날짜별 텍스트 파일 ${d.dailyFileCount}개 · 복구용 임시 세션 ${d.hasRecovery ? '있음' : '없음'} · 음성 파일 0건(저장하지 않음)`;
  }
  $('btnDirSave').onclick = async () => {
    const d = await window.api.setDataDir($('dataDir').value);
    settings.dataDir = $('dataDir').value.trim();
    showDir(d, d.problem ? '' : `${d.dataDir}에 저장합니다. 이전 폴더의 기록은 옮기지 않습니다.`);
    refreshData();
  };
  $('btnDirChoose').onclick = async () => {
    const d = await window.api.chooseDataDir();
    showDir(d);
    refreshData();
  };
  $('btnDirOpen').onclick = () => window.api.openDataDir();
  $('btnDirDefault').onclick = async () => {
    const d = await window.api.setDataDir('');
    showDir(d, d.problem ? '' : `기본 폴더 ${d.dataDir}에 저장합니다.`);
    refreshData();
  };
  $('btnDelete').onclick = async () => {
    if (!confirm('보관된 받아쓰기 기록과 임시 세션을 삭제할까요? 되돌릴 수 없습니다.')) return;
    const r = $('deleteResult');
    try {
      const res = await window.api.deleteData();
      if (res.ok) {
        r.className = 'result ok';
        r.textContent = '삭제했습니다. 이 앱이 보관하던 받아쓰기 데이터가 모두 지워졌습니다.';
      } else {
        const failed = res.results.filter((x) => !x.ok).map((x) => x.name).join(', ');
        r.className = 'result err';
        r.textContent = `일부 데이터(${failed})를 삭제하지 못했습니다. 앱을 다시 시작한 뒤 재시도하거나, 다음 폴더에서 직접 삭제하세요: ${res.location}`;
      }
    } catch (err) {
      r.className = 'result err';
      r.textContent = `삭제 중 오류가 발생했습니다: ${err.message}. 잠시 후 다시 시도하세요.`;
    }
    refreshData();
  };

  bindSettings();
  renderLangChecks();
  renderKeyStatus(state.keys);
  renderShortcuts();
  renderTones();
  showTab(location.hash.slice(1) || 'welcome');
})();
