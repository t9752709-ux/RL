const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('rally', {
  loadState: () => ipcRenderer.invoke('state:load'),
  getAppVersion: () => ipcRenderer.invoke('app:version'),
  minimizeWindow: () => ipcRenderer.invoke('app:window:minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('app:window:toggleMaximize'),
  closeWindow: () => ipcRenderer.invoke('app:window:close'),
  saveState: (state) => ipcRenderer.invoke('state:save', state),
  getConnection: () => ipcRenderer.invoke('game:connection'),
  openTracker: () => ipcRenderer.invoke('tracker:open'),
  chooseGameFolder: () => ipcRenderer.invoke('game:configureFolder'),
  enableStatsApi: (folder) => ipcRenderer.invoke('game:enableStatsApi', folder),
  setOverlayVisible: (visible) => ipcRenderer.invoke('overlay:setVisible', visible),
  setOverlayMovable: (movable) => ipcRenderer.invoke('overlay:setMovable', movable),
  setOverlayCorner: (corner) => ipcRenderer.invoke('overlay:setCorner', corner),
  setControllerOverlayVisible: (visible) => ipcRenderer.invoke('controllerOverlay:setVisible', visible),
  setControllerOverlayScale: (scale) => ipcRenderer.invoke('controllerOverlay:setScale', scale),
  setControllerOverlayMovable: (movable) => ipcRenderer.invoke('controllerOverlay:setMovable', movable),
  getControllerStatus: () => ipcRenderer.invoke('controller:getStatus'),
  reportControllerStatus: (status) => ipcRenderer.send('controller:status', status),
  startSession: (mmr) => ipcRenderer.invoke('session:start', mmr),
  fetchTrackerMmr: () => ipcRenderer.invoke('tracker:fetchMmr'),
  resetSession: () => ipcRenderer.invoke('session:reset'),
  clearSessionStats: () => ipcRenderer.invoke('session:clearStats'),
  copyText: (text) => ipcRenderer.invoke('clipboard:writeText', text),
  recordResult: (result) => ipcRenderer.invoke('session:record', result),
  choosePlayer: (playerId) => ipcRenderer.invoke('app:choosePlayer', playerId),
  onStateChanged: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('app:stateChanged', listener);
    return () => ipcRenderer.removeListener('app:stateChanged', listener);
  },
  onConnectionChanged: (callback) => {
    const listener = (_event, connection) => callback(connection);
    ipcRenderer.on('game:connection', listener);
    return () => ipcRenderer.removeListener('game:connection', listener);
  },
  onControllerStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('controller:statusChanged', listener);
    return () => ipcRenderer.removeListener('controller:statusChanged', listener);
  }
});
