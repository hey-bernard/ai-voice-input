// 확정된 텍스트를 현재 커서가 있는 외부 앱에 붙여넣는다.
// 방식: 클립보드에 텍스트를 넣고 운영체제의 붙여넣기 단축키를 보낸 뒤, 원래 클립보드를 되돌린다.
const { clipboard, systemPreferences } = require('electron');
const { execFile } = require('child_process');

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5000, windowsHide: true }, (err, _stdout, stderr) => {
      if (err) reject(new Error(stderr?.toString().trim() || err.message));
      else resolve();
    });
  });
}

function sendPasteKeystroke() {
  switch (process.platform) {
    case 'darwin':
      return run('osascript', [
        '-e',
        'tell application "System Events" to keystroke "v" using command down',
      ]);
    case 'win32':
      return run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$w = New-Object -ComObject WScript.Shell; $w.SendKeys('^v')",
      ]);
    default:
      return run('xdotool', ['key', '--clearmodifiers', 'ctrl+v']);
  }
}

function canSendKeystrokes() {
  if (process.platform === 'darwin') {
    return systemPreferences.isTrustedAccessibilityClient(false);
  }
  return true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function insertText(text) {
  if (!text) return { ok: false, reason: 'empty', message: '삽입할 텍스트가 없습니다.' };

  if (!canSendKeystrokes()) {
    await clipboard.writeText(text);
    return {
      ok: false,
      reason: 'permission',
      copied: true,
      message:
        '다른 앱에 입력하려면 손쉬운 사용 권한이 필요합니다. 텍스트를 클립보드에 복사했으니 ⌘V로 붙여넣으세요.',
    };
  }

  // 사용자의 기존 클립보드(텍스트, 서식, 이미지 등)를 보관했다가 붙여넣기 후 되돌린다.
  let previous = null;
  try {
    previous = await clipboard.read();
  } catch {
    previous = null;
  }
  await clipboard.writeText(text);
  try {
    await sendPasteKeystroke();
  } catch (err) {
    // 실패하면 텍스트를 클립보드에 남겨 사용자가 직접 붙여넣을 수 있게 한다.
    return {
      ok: false,
      reason: 'keystroke',
      copied: true,
      message: `현재 앱에 자동으로 입력하지 못했습니다(${err.message}). 텍스트를 클립보드에 복사했으니 직접 붙여넣으세요.`,
    };
  }
  // 대상 앱이 붙여넣기를 처리할 시간을 준 뒤 원래 클립보드를 복원한다.
  await sleep(450);
  try {
    // 그사이 사용자가 다른 것을 복사했다면 덮어쓰지 않는다.
    if ((await clipboard.readText()) === text) {
      if (previous && previous.length) await clipboard.write(previous);
      else await clipboard.clear();
    }
  } catch {
    // 복원에 실패해도 삽입 자체는 성공했으므로 무시한다.
  }
  return { ok: true };
}

module.exports = { insertText, canSendKeystrokes };
