// 실제 Electron 앱을 가상 마이크로 띄워 받아쓰기 → 다듬기 → 검토 → 삽입 흐름을 확인한다.
// AI 호출은 가짜 응답으로 바꿔 끼워 API 키 없이 실행한다.
// 실행: xvfb-run -a node test/e2e.electron.js
const { _electron: electron } = require('playwright');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const outDir = process.env.E2E_OUT || path.join(os.tmpdir(), 'voice-input-e2e');
fs.mkdirSync(outDir, { recursive: true });

// 1.2초 소리 + 1.6초 침묵을 반복하는 가짜 마이크 입력
function writeWav(file) {
  const rate = 16000;
  const seconds = 8.4;
  const n = Math.floor(rate * seconds);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const inBurst = t % 2.8 < 1.2;
    const v = inBurst ? Math.sin(2 * Math.PI * 220 * t) * 0.5 + Math.sin(2 * Math.PI * 440 * t) * 0.2 : 0;
    data.writeInt16LE(Math.round(v * 32767 * 0.8), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
}

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-home-'));
  const wav = path.join(home, 'speech.wav');
  writeWav(wav);
  const userData = path.join(home, '.config', 'AI Voice Input');
  const recordDir = path.join(home, 'AI', 'aI_record'); // Windows 의 D:\AI\aI_record 에 해당
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ onboardingDone: true, privacyAccepted: true, dataDir: recordDir }));

  const app = await electron.launch({
    executablePath: path.join(root, 'node_modules/electron/dist/electron'),
    args: [root, '--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`],
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), OPENAI_API_KEY: 'test', ANTHROPIC_API_KEY: 'test' },
  });

  // AI 호출을 가짜 응답으로 교체
  await app.evaluate(({ ipcMain }) => {
    let n = 0;
    const said = ['어 그러니까 내일 회의는 음 세 시에 하는 걸로 하죠', '그리고 자료는 제가 아니 민수 씨가 준비해 주세요', 'Please send the deck to the client by Friday'];
    ipcMain.removeHandler('ai:transcribe');
    ipcMain.handle('ai:transcribe', async (_e, p) => {
      globalThis.__lastAudioBytes = p.audio.byteLength;
      await new Promise((r) => setTimeout(r, 300));
      const text = said[n % said.length];
      const lang = n % said.length === 2 ? 'en' : 'ko';
      n++;
      return { ok: true, text, languages: [lang], languageUncertain: false, unsupported: [] };
    });
    ipcMain.removeHandler('ai:polish');
    ipcMain.handle('ai:polish', async (_e, p) => {
      await new Promise((r) => setTimeout(r, 300));
      if (p.text.startsWith('그리고')) return { ok: false, error: 'Claude 사용량 한도에 도달했습니다. 잠시 후 다시 시도하세요.' };
      const map = {
        '어 그러니까 내일 회의는 음 세 시에 하는 걸로 하죠': '내일 회의는 3시에 진행하겠습니다.',
        'Please send the deck to the client by Friday': 'Please send the deck to the client by Friday.',
      };
      return { ok: true, text: map[p.text] || p.text };
    });
  });

  // 투명 창은 가상 디스플레이에서 page.screenshot 이 멈출 수 있어 Electron 의 capturePage 로 찍는다.
  async function shot(name, title) {
    const b64 = await app.evaluate(async ({ BrowserWindow }, t) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === t);
      return (await w.webContents.capturePage()).toPNG().toString('base64');
    }, title);
    fs.writeFileSync(path.join(outDir, name), Buffer.from(b64, 'base64'));
  }

  await app.firstWindow();
  let win = app.windows().find((w) => w.url().includes('overlay.html'));
  if (!win) win = await app.waitForEvent('window', (w) => w.url().includes('overlay.html'));
  await win.waitForLoadState('domcontentloaded');
  win.on('console', (m) => console.log('[renderer]', m.type(), m.text()));
  win.on('pageerror', (e) => console.log('[renderer error]', e.message));
  await win.waitForFunction(() => window.__voice);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('overlay')).show());

  // 1) 시작 화면
  await shot('1-idle.png', '받아쓰기');

  // 2) 전역 단축키와 같은 경로로 녹음 시작
  console.log('windows:', await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle() + ' ' + w.webContents.getURL())));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('overlay')).webContents.send('hotkey', 'toggle'));
  await win.waitForFunction(() => window.__voice.session.state === 'recording');
  const statusText = await win.textContent('#statusText');
  assert.equal(statusText, '녹음 중');

  // 침묵으로 나뉜 문장 묶음 3개가 생길 때까지 기다린다
  await win.waitForFunction(() => window.__voice.session.bundles.filter((b) => b.status !== 'transcribing' && b.status !== 'polishing').length >= 3, null, { timeout: 20000 });
  await shot('2-recording.png', '받아쓰기');

  // 3) 일시정지 → 상태 표시
  await win.keyboard.press('Alt+P');
  await win.waitForFunction(() => window.__voice.session.state === 'paused');
  assert.equal(await win.textContent('#statusText'), '일시정지');

  // 4) 종료
  await win.click('#btnStop');
  await win.waitForFunction(() => window.__voice.session.state === 'stopped');
  const bundles = await win.evaluate(() => window.__voice.session.bundles.map(({ seq, status, raw, text, errorStage, languages }) => ({ seq, status, raw, text, errorStage, languages })));
  console.log('bundles:', JSON.stringify(bundles, null, 1));
  assert.ok(bundles.length >= 3, '문장 묶음이 3개 이상이어야 한다');
  assert.equal(bundles[0].text, '내일 회의는 3시에 진행하겠습니다.');
  assert.equal(bundles[1].status, 'error');
  assert.equal(bundles[1].errorStage, 'polish');
  assert.equal(bundles[1].text, bundles[1].raw, '다듬기 실패 시 원문 보존');
  assert.deepEqual(bundles[2].languages, ['en']);
  assert.ok(await app.evaluate(() => globalThis.__lastAudioBytes) > 1000, '오디오 조각이 전달되어야 한다');

  // 아직 삽입하지 않은 문장은 복구용 임시 세션으로 저장 폴더에 남는다
  await win.waitForTimeout(600);
  assert.ok(fs.existsSync(path.join(recordDir, 'recovery.json')), '저장 폴더에 recovery.json');

  // 5) 첫 묶음을 직접 수정하고, 세 번째 묶음은 제외
  const first = win.locator('section.bundle').nth(0).locator('textarea');
  await first.fill('내일 회의는 오후 3시에 진행하겠습니다.');
  await win.locator('section.bundle').nth(2).getByRole('button', { name: '제외' }).click();
  await shot('3-review.png', '받아쓰기');

  // 6) 삽입: 이 환경에는 xdotool 이 없으므로 클립보드 복사 대체 경로가 동작해야 한다
  await win.keyboard.press('Control+Enter');
  await win.waitForSelector('.msg.warn, .msg.error, .msg.ok');
  const clip = await app.evaluate(({ clipboard }) => clipboard.readText());
  console.log('clipboard:', JSON.stringify(clip));
  assert.equal(clip, '내일 회의는 오후 3시에 진행하겠습니다. 그리고 자료는 제가 아니 민수 씨가 준비해 주세요');
  const msg = await win.textContent('.messages');
  console.log('message:', msg);
  await shot('4-inserted.png', '받아쓰기');

  // 삽입·제외로 남은 문장이 없으므로 임시 세션은 지워져야 한다
  await win.waitForTimeout(600);
  assert.ok(!fs.existsSync(path.join(recordDir, 'recovery.json')), '처리 끝난 임시 세션 삭제');
  // 기록 파일 확인: 삽입 성공 경로를 흉내 내 기록을 남긴다
  await app.evaluate(({}, root) => process.mainModule.require(root + '/src/main/store.js').appendHistory({ text: '테스트 기록' }), root);
  const daily = fs.readdirSync(recordDir).filter((n) => n.startsWith('받아쓰기-'));
  console.log('record dir:', fs.readdirSync(recordDir));
  assert.equal(daily.length, 1);

  // 7) 설정 창: 데이터 삭제
  await win.evaluate(() => window.api.openSettings('data'));
  const settingsWin = await app.waitForEvent('window');
  await settingsWin.waitForLoadState('domcontentloaded');
  await settingsWin.waitForSelector('#tab-data:not([hidden])');
  await settingsWin.waitForFunction(() => !document.getElementById('dataSummary').textContent.includes('확인 중'));
  await shot('5-settings-data.png', 'AI 음성 입력 설정');
  settingsWin.on('dialog', (d) => d.accept());
  await settingsWin.click('#btnDelete');
  await settingsWin.waitForFunction(() => document.getElementById('deleteResult').textContent.length > 0);
  console.log('delete:', await settingsWin.textContent('#deleteResult'));
  console.log('record dir after delete:', fs.readdirSync(recordDir));
  assert.deepEqual(fs.readdirSync(recordDir), []);

  await settingsWin.click('[data-tab=welcome]');
  await settingsWin.waitForFunction(() => document.getElementById('permPill').textContent !== '확인 중');
  await shot('6-settings-welcome.png', 'AI 음성 입력 설정');
  await settingsWin.click('[data-tab=shortcuts]');
  await shot('7-settings-shortcuts.png', 'AI 음성 입력 설정');

  await app.evaluate(({ app }) => { app.isQuitting = true; app.quit(); });
  console.log('E2E OK — screenshots in', outDir);
})().catch((err) => {
  console.error('E2E FAILED:', err);
  process.exit(1);
});
