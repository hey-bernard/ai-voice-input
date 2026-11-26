// 설정·API 키는 앱 설정 폴더에, 받아쓰기 기록·복구용 임시 세션은 사용자가 지정한 저장 폴더에 보관한다.
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

// Windows 기본 저장 폴더. 다른 운영체제는 앱 설정 폴더 아래 records 를 쓴다.
const WINDOWS_DEFAULT_DATA_DIR = 'D:\\AI\\aI_record';

function defaultDataDir() {
  return process.platform === 'win32'
    ? WINDOWS_DEFAULT_DATA_DIR
    : path.join(app.getPath('userData'), 'records');
}

const DEFAULT_SETTINGS = {
  onboardingDone: false,
  privacyAccepted: false,
  shortcuts: {
    toggle: 'CommandOrControl+Shift+Space',
    insert: 'CommandOrControl+Shift+Enter',
  },
  toneId: 'formal',
  customTones: [],
  // 'auto' 이면 후보 언어 안에서 자동 감지, 아니면 고정 언어 코드
  languageMode: 'auto',
  languages: ['ko', 'en'],
  fallbackLanguage: 'ko',
  transcribeModel: 'gpt-transcribe',
  polishModel: 'claude-opus-5-5',
  polishEffort: 'low',
  silenceMs: 900,
  micDeviceId: '',
  saveHistory: true, // 삽입한 텍스트를 저장 폴더에 기록(설정에서 끌 수 있음)
  insertSeparator: 'space',
  dataDir: '', // 비어 있으면 defaultDataDir()
};

// ---------- 파일 유틸 ----------
function configDir() {
  return app.getPath('userData');
}
function readJsonAt(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJsonAt(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}
const configFile = (name) => path.join(configDir(), name);

// ---------- 설정 ----------
let settingsCache = null;
function getSettings() {
  if (!settingsCache) {
    const saved = readJsonAt(configFile('settings.json'), {});
    settingsCache = {
      ...DEFAULT_SETTINGS,
      ...saved,
      shortcuts: { ...DEFAULT_SETTINGS.shortcuts, ...(saved.shortcuts || {}) },
    };
  }
  return settingsCache;
}
function setSettings(patch) {
  settingsCache = { ...getSettings(), ...patch };
  writeJsonAt(configFile('settings.json'), settingsCache);
  return settingsCache;
}

// ---------- 저장 폴더 ----------
// 지정한 폴더를 만들 수 없으면(예: D 드라이브가 없음) 앱 설정 폴더로 대체하고 그 사실을 알린다.
let dataDirProblem = null;
function dataDirInfo() {
  const wanted = getSettings().dataDir || defaultDataDir();
  try {
    fs.mkdirSync(wanted, { recursive: true });
    fs.accessSync(wanted, fs.constants.W_OK);
    dataDirProblem = null;
    return { path: wanted, wanted, fallback: false };
  } catch (err) {
    const fallback = path.join(configDir(), 'records');
    fs.mkdirSync(fallback, { recursive: true });
    dataDirProblem = `${wanted} 폴더를 사용할 수 없어 ${fallback}에 저장합니다. (${err.code || err.message})`;
    return { path: fallback, wanted, fallback: true, problem: dataDirProblem };
  }
}
const dataFile = (name) => path.join(dataDirInfo().path, name);

// ---------- API 키 (운영체제 보안 저장소로 암호화) ----------
let keyCache = null;
async function encryptionAvailable() {
  try {
    return await safeStorage.isAsyncEncryptionAvailable();
  } catch {
    return false;
  }
}
async function getKeys() {
  if (keyCache) return keyCache;
  const raw = readJsonAt(configFile('keys.json'), {});
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === '__plain') continue;
    try {
      out[k] = raw.__plain ? v : (await safeStorage.decryptStringAsync(Buffer.from(v, 'base64'))).result;
    } catch {
      out[k] = '';
    }
  }
  keyCache = out;
  return out;
}
async function setKey(name, value) {
  const encrypted = await encryptionAvailable();
  const keys = { ...(await getKeys()) };
  if (value) keys[name] = value;
  else delete keys[name];
  const next = encrypted ? {} : { __plain: true };
  for (const [k, v] of Object.entries(keys)) {
    if (!v) continue;
    next[k] = encrypted ? (await safeStorage.encryptStringAsync(v)).toString('base64') : v;
  }
  writeJsonAt(configFile('keys.json'), next);
  keyCache = keys;
}
async function keyStatus() {
  const keys = await getKeys();
  return {
    openai: Boolean(keys.openai || process.env.OPENAI_API_KEY),
    anthropic: Boolean(keys.anthropic || process.env.ANTHROPIC_API_KEY),
    encrypted: await encryptionAvailable(),
  };
}

// ---------- 기록 ----------
// '기록 보관'이 켜져 있으면(기본값) 삽입한 텍스트를 저장한다. 음성은 저장하지 않는다.
// history.json(앱이 읽는 기록)과 날짜별 텍스트 파일(사람이 읽는 기록)을 함께 남긴다.
const DAILY_RE = /^받아쓰기-\d{4}-\d{2}-\d{2}\.txt$/;
function pad(n) {
  return String(n).padStart(2, '0');
}
function appendHistory(entry) {
  if (!getSettings().saveHistory) return;
  const now = new Date();
  const list = readJsonAt(dataFile('history.json'), []);
  list.push({ ...entry, at: now.toISOString() });
  writeJsonAt(dataFile('history.json'), list.slice(-500));
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  fs.appendFileSync(dataFile(`받아쓰기-${day}.txt`), `[${time}]\n${entry.text}\n\n`, 'utf8');
}
function getHistory() {
  return readJsonAt(dataFile('history.json'), []);
}
function dailyFiles() {
  try {
    return fs.readdirSync(dataDirInfo().path).filter((n) => DAILY_RE.test(n));
  } catch {
    return [];
  }
}

// ---------- 복구용 임시 세션 ----------
function saveRecovery(session) {
  writeJsonAt(dataFile('recovery.json'), session);
}
function loadRecovery() {
  return readJsonAt(dataFile('recovery.json'), null);
}
function clearRecovery() {
  fs.rmSync(dataFile('recovery.json'), { force: true });
}

// ---------- 삭제 ----------
// 앱이 만든 파일만 지운다. 저장 폴더 안의 다른 파일은 건드리지 않는다.
function deleteAllData() {
  const dir = dataDirInfo().path;
  const names = ['history.json', 'recovery.json', ...dailyFiles()];
  const results = [];
  for (const name of names) {
    const f = path.join(dir, name);
    try {
      fs.rmSync(f, { force: true });
      results.push({ name, ok: !fs.existsSync(f) });
    } catch (err) {
      results.push({ name, ok: false, error: err.message });
    }
  }
  return { ok: results.every((r) => r.ok), results, location: dir };
}

function dataSummary() {
  const info = dataDirInfo();
  return {
    historyCount: getHistory().length,
    dailyFileCount: dailyFiles().length,
    hasRecovery: Boolean(loadRecovery()),
    dataDir: info.path,
    wantedDir: info.wanted,
    defaultDir: defaultDataDir(),
    problem: info.problem || null,
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  WINDOWS_DEFAULT_DATA_DIR,
  getSettings,
  setSettings,
  getKeys,
  setKey,
  keyStatus,
  appendHistory,
  getHistory,
  saveRecovery,
  loadRecovery,
  clearRecovery,
  deleteAllData,
  dataSummary,
  dataDirInfo,
};
