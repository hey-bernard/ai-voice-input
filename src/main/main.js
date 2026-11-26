const path = require('path');
const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  Tray,
  nativeImage,
  screen,
  session,
  shell,
  systemPreferences,
  clipboard,
  dialog,
} = require('electron');
const store = require('./store');
const { createAi, SUPPORTED_LANGUAGES, BUILTIN_TONES } = require('./ai');
const { insertText, canSendKeystrokes } = require('./insert');

const RENDERER = path.join(__dirname, '..', 'renderer');
const ASSETS = path.join(__dirname, '..', 'assets');
const isMac = process.platform === 'darwin';

let overlay = null;
let settingsWin = null;
let tray = null;
const ai = createAi({ getKeys: store.getKeys, getSettings: store.getSettings });
const shortcutErrors = {};

// 설정 폴더 이름을 고정해 실행 방식과 관계없이 같은 위치를 쓰게 한다.
app.setPath('userData', path.join(app.getPath('appData'), 'AI Voice Input'));

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

function webPrefs() {
  return {
    preload: path.join(__dirname, '..', 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    backgroundThrottling: false,
  };
}

function createOverlay() {
  overlay = new BrowserWindow({
    width: 480,
    height: 560,
    show: false,
    frame: false,
    resizable: true,
    minWidth: 380,
    minHeight: 320,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    backgroundColor: '#00000000',
    transparent: true,
    hasShadow: true,
    title: '받아쓰기',
    ...(isMac ? { type: 'panel' } : {}),
    webPreferences: webPrefs(),
  });
  overlay.setAlwaysOnTop(true, 'floating');
  overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlay.loadFile(path.join(RENDERER, 'overlay.html'));
  overlay.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      overlay.hide();
    }
  });
}

function positionOverlay() {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x, y, width, height } = display.workArea;
  const [w, h] = overlay.getSize();
  overlay.setPosition(Math.round(x + (width - w) / 2), Math.round(y + height - h - 24));
}

function showOverlay({ focus = false } = {}) {
  if (!overlay.isVisible()) positionOverlay();
  // 기본은 포커스를 빼앗지 않고 띄워, 사용자가 쓰던 앱의 커서가 그대로 유지되게 한다.
  if (focus) overlay.show();
  else overlay.showInactive();
}

function openSettings(tab) {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    if (tab) settingsWin.webContents.send('settings:tab', tab);
    return;
  }
  settingsWin = new BrowserWindow({
    width: 760,
    height: 680,
    minWidth: 560,
    minHeight: 480,
    title: 'AI 음성 입력 설정',
    webPreferences: webPrefs(),
  });
  settingsWin.removeMenu();
  settingsWin.loadFile(path.join(RENDERER, 'settings.html'), tab ? { hash: tab } : undefined);
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
}

function registerShortcuts() {
  // 일시 중지 중에는 새 등록이 실패하므로 먼저 재개한다.
  globalShortcut.setSuspended(false);
  globalShortcut.unregisterAll();
  const { shortcuts } = store.getSettings();
  const actions = {
    toggle: () => {
      showOverlay();
      overlay.webContents.send('hotkey', 'toggle');
    },
    insert: () => overlay.webContents.send('hotkey', 'insert'),
  };
  for (const [kind, accel] of Object.entries(shortcuts)) {
    delete shortcutErrors[kind];
    if (!accel) continue;
    let ok = false;
    try {
      ok = globalShortcut.register(accel, actions[kind]);
    } catch (err) {
      shortcutErrors[kind] = `단축키 형식이 올바르지 않습니다: ${err.message}`;
      continue;
    }
    if (!ok) shortcutErrors[kind] = '다른 앱이 이미 사용 중인 단축키입니다. 다른 조합을 선택하세요.';
  }
  updateTrayMenu();
}

function trayIcon() {
  const img = nativeImage.createFromPath(path.join(ASSETS, isMac ? 'trayTemplate.png' : 'tray.png'));
  if (isMac) img.setTemplateImage(true);
  return img;
}

function updateTrayMenu() {
  if (!tray) return;
  const { shortcuts } = store.getSettings();
  const pretty = (a) => (a || '없음').replace('CommandOrControl', isMac ? '⌘' : 'Ctrl');
  tray.setToolTip(`AI 음성 입력 — ${pretty(shortcuts.toggle)}로 받아쓰기`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: `받아쓰기 시작/종료 (${pretty(shortcuts.toggle)})`,
        click: () => {
          showOverlay({ focus: true });
          overlay.webContents.send('hotkey', 'toggle');
        },
      },
      { label: '받아쓰기 창 열기', click: () => showOverlay({ focus: true }) },
      { type: 'separator' },
      { label: '설정…', click: () => openSettings() },
      ...(Object.keys(shortcutErrors).length
        ? [{ label: '⚠ 단축키 충돌 — 설정에서 변경', click: () => openSettings('shortcuts') }]
        : []),
      { type: 'separator' },
      { label: '종료', role: 'quit' },
    ]),
  );
}

function micStatus() {
  if (process.platform === 'darwin' || process.platform === 'win32') {
    return systemPreferences.getMediaAccessStatus('microphone');
  }
  return 'granted';
}

const SETTINGS_URLS = {
  darwin: {
    microphone: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone',
    accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  },
  win32: { microphone: 'ms-settings:privacy-microphone' },
};

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    platform: process.platform,
    languages: SUPPORTED_LANGUAGES,
    builtinTones: BUILTIN_TONES.map(({ id, name }) => ({ id, name })),
  }));

  ipcMain.handle('settings:get', async () => ({
    settings: store.getSettings(),
    keys: await store.keyStatus(),
    shortcutErrors,
  }));
  ipcMain.handle('settings:set', (_e, patch) => {
    const before = JSON.stringify(store.getSettings().shortcuts);
    const s = store.setSettings(patch);
    if (JSON.stringify(s.shortcuts) !== before) registerShortcuts();
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('settings:changed', s);
    return { settings: s, shortcutErrors };
  });
  ipcMain.handle('keys:set', async (_e, name, value) => {
    if (!['openai', 'anthropic'].includes(name)) throw new Error('알 수 없는 키 이름');
    await store.setKey(name, (value || '').trim());
    return store.keyStatus();
  });
  ipcMain.handle('shortcut:suspend', (_e, suspended) => {
    // 설정 화면에서 새 단축키를 입력받는 동안 기존 전역 단축키가 가로채지 않도록 잠시 멈춘다.
    if (suspended) globalShortcut.setSuspended(true);
    else registerShortcuts();
  });

  ipcMain.handle('ai:transcribe', (_e, payload) => ai.transcribe(payload));
  ipcMain.handle('ai:polish', (_e, payload) => ai.polish(payload));

  ipcMain.handle('insert:text', async (_e, { text, keepOpen }) => {
    const hadFocus = overlay.isFocused();
    overlay.hide();
    if (hadFocus) {
      // 받아쓰기 창이 포커스를 가지고 있었다면 원래 앱으로 포커스를 돌려준다.
      if (isMac && !(settingsWin && settingsWin.isVisible())) app.hide();
      await new Promise((r) => setTimeout(r, 220));
    } else {
      await new Promise((r) => setTimeout(r, 60));
    }
    const result = await insertText(text);
    if (result.ok) store.appendHistory({ text });
    if (!result.ok || keepOpen) showOverlay({ focus: !result.ok });
    return result;
  });
  ipcMain.handle('clipboard:copy', async (_e, text) => {
    await clipboard.writeText(text);
    return true;
  });

  ipcMain.handle('perm:status', () => ({
    microphone: micStatus(),
    accessibility: canSendKeystrokes(),
    accessibilityRequired: isMac,
    platform: process.platform,
  }));
  ipcMain.handle('perm:request', async (_e, kind) => {
    if (kind === 'microphone' && isMac) return systemPreferences.askForMediaAccess('microphone');
    if (kind === 'accessibility' && isMac) return systemPreferences.isTrustedAccessibilityClient(true);
    return true;
  });
  ipcMain.handle('perm:openSettings', (_e, kind) => {
    const url = SETTINGS_URLS[process.platform]?.[kind];
    if (url) shell.openExternal(url);
    return Boolean(url);
  });

  ipcMain.handle('recovery:save', (_e, data) => store.saveRecovery(data));
  ipcMain.handle('recovery:load', () => store.loadRecovery());
  ipcMain.handle('recovery:clear', () => store.clearRecovery());
  ipcMain.handle('data:summary', () => store.dataSummary());
  ipcMain.handle('data:chooseDir', async () => {
    const current = store.dataDirInfo().path;
    const r = await dialog.showOpenDialog(settingsWin || undefined, {
      title: '받아쓰기 기록 저장 폴더 선택',
      defaultPath: current,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return store.dataSummary();
    store.setSettings({ dataDir: r.filePaths[0] });
    return store.dataSummary();
  });
  ipcMain.handle('data:setDir', (_e, dir) => {
    store.setSettings({ dataDir: (dir || '').trim() });
    return store.dataSummary();
  });
  ipcMain.handle('data:openDir', async () => {
    const err = await shell.openPath(store.dataDirInfo().path);
    return !err;
  });
  ipcMain.handle('data:delete', () => {
    const result = store.deleteAllData();
    overlay?.webContents.send('data:deleted');
    return result;
  });

  ipcMain.handle('window:hide', () => overlay.hide());
  ipcMain.handle('window:focus', () => showOverlay({ focus: true }));
  ipcMain.handle('window:settings', (_e, tab) => openSettings(tab));
  ipcMain.handle('onboarding:done', () => {
    store.setSettings({ onboardingDone: true });
    settingsWin?.close();
    showOverlay({ focus: true });
  });
}

app.whenReady().then(() => {
  if (isMac) app.dock?.hide();

  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    const fromApp = wc.getURL().startsWith('file://');
    cb(fromApp && (permission === 'media' || permission === 'clipboard-sanitized-write'));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission) => {
    return Boolean(wc?.getURL().startsWith('file://')) && permission === 'media';
  });

  registerIpc();
  createOverlay();
  tray = new Tray(trayIcon());
  tray.on('click', () => !isMac && showOverlay({ focus: true }));
  registerShortcuts();

  const s = store.getSettings();
  if (!s.onboardingDone || !s.privacyAccepted) openSettings('welcome');
});

app.on('second-instance', () => showOverlay({ focus: true }));
app.on('before-quit', () => {
  app.isQuitting = true;
});
app.on('will-quit', () => globalShortcut.unregisterAll());
// 창을 모두 닫아도 트레이에서 계속 동작한다.
app.on('window-all-closed', () => {});
