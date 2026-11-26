const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('api', {
  info: invoke('app:info'),
  getSettings: invoke('settings:get'),
  setSettings: invoke('settings:set'),
  setKey: invoke('keys:set'),
  suspendShortcuts: invoke('shortcut:suspend'),
  transcribe: invoke('ai:transcribe'),
  polish: invoke('ai:polish'),
  insert: invoke('insert:text'),
  copy: invoke('clipboard:copy'),
  permStatus: invoke('perm:status'),
  permRequest: invoke('perm:request'),
  permOpenSettings: invoke('perm:openSettings'),
  saveRecovery: invoke('recovery:save'),
  loadRecovery: invoke('recovery:load'),
  clearRecovery: invoke('recovery:clear'),
  dataSummary: invoke('data:summary'),
  deleteData: invoke('data:delete'),
  chooseDataDir: invoke('data:chooseDir'),
  setDataDir: invoke('data:setDir'),
  openDataDir: invoke('data:openDir'),
  hide: invoke('window:hide'),
  focus: invoke('window:focus'),
  openSettings: invoke('window:settings'),
  onboardingDone: invoke('onboarding:done'),
  on: (channel, fn) => {
    const allowed = ['hotkey', 'settings:changed', 'settings:tab', 'data:deleted'];
    if (!allowed.includes(channel)) return () => {};
    const handler = (_e, ...args) => fn(...args);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
});
