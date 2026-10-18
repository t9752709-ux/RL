const { app, BrowserWindow, clipboard, dialog, ipcMain, net, screen, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const WebSocket = require('ws');
const RallyRanks = require('./rank-utils');

const STATE_FILE = 'rally-state.json';
const STATS_WS_URL = 'ws://127.0.0.1:49124';
const TRACKED_PLAYLIST_IDS = ['10', '11', '13'];
const DEFAULT_STATE = {
  settings: {
    playerId: '',
    playerName: '',
    mmrMode: 'tracker',
    playlistId: '11',
    overlayPlaylistId: '11',
    mmrByPlaylist: {},
    rankByPlaylist: {},
    winMmr: 9,
    lossMmr: 9,
    sessionGoalMmr: 50,
    overlayCorner: 'top-right',
    overlayOffsetX: 0,
    overlayOffsetY: 0,
    overlayStyle: 'glass',
    overlayScale: 100,
    overlayLayout: 'accent-bar',
    overlayOpacity: 65,
    overlayBounds: null,
    overlayMovable: false,
    overlayVisible: true,
    controllerOverlayVisible: false,
    controllerOverlayBounds: null,
    controllerOverlayMovable: false,
    controllerOverlayScale: 100,
    installPath: ''
  },
  session: {
    active: false,
    startMmr: null,
    currentMmr: null,
    wins: 0,
    losses: 0,
    streakType: '',
    streakCount: 0,
    mmrStepHistory: [],
    history: []
  }
};

let state = structuredClone(DEFAULT_STATE);
let mainWindow;
let overlayWindow;
let controllerWindow;
let controllerBoundsTimer;
let overlayBoundsTimer;
let statsSocket;
let reconnectTimer;
let quitting = false;
let lastGameGuid = '';
let localTeamNum = null;
let roundStarted = false;
let replayLoaded = false;
let connection = { connected: false, players: [], gameActive: false, playlistId: '', message: 'En attente de Rocket League…', trackerMessage: 'Recherche automatique du compte…' };
const seenMatches = new Set();
let trackerSyncRunning = false;
let autoStartMatchGuid = '';
let baselineSyncSessionStartedAt = '';
let baselineSyncAttemptAt = 0;
let idleMmrTimer;
let lastIdleMmrSyncAt = 0;
let cachedLocalIds = new Set();
let localIdsScannedAt = 0;
let controllerStatus = { connected: false, name: '' };

const OVERLAY_LAYOUT_SIZES = {
  'accent-bar': { width: 760, height: 102 },
  'accent-grid': { width: 450, height: 190 },
  'accent-stack': { width: 270, height: 370 },
  'accent-slim': { width: 900, height: 72 }
};
const OVERLAY_MIN_SCALE = 40;
const OVERLAY_MAX_SCALE = 160;
const OVERLAY_MIN_OPACITY = 20;
const OVERLAY_MAX_OPACITY = 100;
const CONTROLLER_OVERLAY_BASE_WIDTH = 520;
const CONTROLLER_OVERLAY_BASE_HEIGHT = 387;
const CONTROLLER_OVERLAY_MIN_SCALE = 35;
const CONTROLLER_OVERLAY_MAX_SCALE = 100;
const LOCAL_UPDATE_DIR = path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'Rally', 'Updates');
const UPDATE_CONFIG_FILE = path.join(__dirname, 'update-config.json');
const UPDATE_REQUEST_TIMEOUT_MS = 12000;
const MAX_UPDATE_INSTALLER_BYTES = 350 * 1024 * 1024;

const TRACKER_RELAY = 'https://rlapi-serve.nixvio64.workers.dev';
const TRACKER_TIMEOUT_MS = 8000;

function dataFile() {
  return path.join(app.getPath('userData'), STATE_FILE);
}

function compareVersions(left, right) {
  const a = String(left).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const b = String(right).split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function normalizeSessionGoalMmr(value) {
  const goal = Number(value);
  return [25, 50, 100].includes(goal) ? goal : DEFAULT_STATE.settings.sessionGoalMmr;
}

function normalizeOverlayScale(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 100;
  return Math.round(Math.min(OVERLAY_MAX_SCALE, Math.max(OVERLAY_MIN_SCALE, parsed)));
}

function normalizeOverlayOpacity(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_STATE.settings.overlayOpacity;
  return Math.round(Math.min(OVERLAY_MAX_OPACITY, Math.max(OVERLAY_MIN_OPACITY, parsed)));
}

function normalizeOverlayLayout(value) {
  return ['accent-bar', 'accent-grid', 'accent-stack', 'accent-slim'].includes(value) ? value : 'accent-bar';
}

function overlayLayoutSize(value) {
  return OVERLAY_LAYOUT_SIZES[normalizeOverlayLayout(value)];
}

function normalizeOverlayBounds(value) {
  if (!value || typeof value !== 'object') return null;
  const x = Number(value.x);
  const y = Number(value.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

function normalizeOverlayOffset(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(Math.min(250, Math.max(-250, parsed)) / 5) * 5;
}

function normalizeOverlayStyle(value) {
  return ['glass', 'minimal', 'neon'].includes(value) ? value : 'glass';
}

function clearLocalUpdateFiles() {
  for (const file of ['Rally-Update.exe', 'latest.json']) {
    try { fs.rmSync(path.join(LOCAL_UPDATE_DIR, file), { force: true }); } catch {}
  }
}

function localUpdateManifest() {
  const manifestPath = path.join(LOCAL_UPDATE_DIR, 'latest.json');
  let update;
  try {
    update = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch {
    return null;
  }

  if (update?.installer !== 'Rally-Update.exe' || typeof update.version !== 'string') return null;
  const installerPath = path.join(LOCAL_UPDATE_DIR, update.installer);
  if (!fs.existsSync(installerPath)) return null;
  if (compareVersions(update.version, app.getVersion()) <= 0) {
    clearLocalUpdateFiles();
    return null;
  }
  return { source: 'local', version: update.version, installerPath };
}

function readUpdateConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(UPDATE_CONFIG_FILE, 'utf8'));
    return {
      githubOwner: String(config.githubOwner || '').trim(),
      githubRepo: String(config.githubRepo || '').trim()
    };
  } catch {
    return { githubOwner: '', githubRepo: '' };
  }
}

function requestHttpsResponse(url, headers = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      reject(new Error('Adresse de mise à jour invalide.'));
      return;
    }
    if (parsedUrl.protocol !== 'https:') {
      reject(new Error('Les mises à jour doivent utiliser HTTPS.'));
      return;
    }

    const request = https.get(parsedUrl, { headers }, (response) => {
      const redirectStatus = [301, 302, 303, 307, 308].includes(response.statusCode);
      if (redirectStatus && response.headers.location) {
        response.resume();
        if (redirects >= 5) {
          reject(new Error('Trop de redirections pendant la mise à jour.'));
          return;
        }
        const redirectUrl = new URL(response.headers.location, parsedUrl).toString();
        requestHttpsResponse(redirectUrl, headers, redirects + 1).then(resolve, reject);
        return;
      }
      resolve(response);
    });
    request.setTimeout(UPDATE_REQUEST_TIMEOUT_MS, () => request.destroy(new Error('Délai dépassé pendant la connexion au serveur de mise à jour.')));
    request.once('error', reject);
  });
}

async function fetchHttpsText(url, headers = {}, maxBytes = 1024 * 1024) {
  const response = await requestHttpsResponse(url, headers);
  if (response.statusCode !== 200) {
    response.resume();
    const error = new Error(`Le serveur de mise à jour a répondu ${response.statusCode || 'sans statut'}.`);
    error.statusCode = response.statusCode;
    throw error;
  }

  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    response.setEncoding('utf8');
    response.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk, 'utf8');
      if (bytes > maxBytes) {
        response.destroy(new Error('Réponse du serveur de mise à jour trop volumineuse.'));
        return;
      }
      body += chunk;
    });
    response.once('end', () => resolve(body));
    response.once('error', reject);
  });
}

async function findGitHubUpdate() {
  const { githubOwner, githubRepo } = readUpdateConfig();
  if (!githubOwner || !githubRepo) return null;

  const owner = encodeURIComponent(githubOwner);
  const repo = encodeURIComponent(githubRepo);
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
  const releaseText = await fetchHttpsText(apiUrl, {
    Accept: 'application/vnd.github+json',
    'User-Agent': `Overlay-RL/${app.getVersion()}`
  });
  const release = JSON.parse(releaseText);
  const version = String(release.tag_name || '').replace(/^v/i, '');
  if (release.draft || release.prerelease || !/^\d+(?:\.\d+){1,2}$/.test(version)) return null;
  if (compareVersions(version, app.getVersion()) <= 0) return null;

  const installerName = `Overlay-RL-Setup-v${version}.exe`;
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const installer = assets.find((asset) => asset.name === installerName);
  const checksum = assets.find((asset) => asset.name === `${installerName}.sha256`);
  if (!installer?.browser_download_url || !checksum?.browser_download_url) return null;

  return {
    source: 'github',
    version,
    installerUrl: installer.browser_download_url,
    checksumUrl: checksum.browser_download_url
  };
}

async function downloadHttpsFile(url, destination) {
  const response = await requestHttpsResponse(url, { 'User-Agent': `Overlay-RL/${app.getVersion()}` });
  if (response.statusCode !== 200) {
    response.resume();
    throw new Error(`Téléchargement refusé par le serveur (${response.statusCode || 'sans statut'}).`);
  }

  await new Promise((resolve, reject) => {
    let bytes = 0;
    const output = fs.createWriteStream(destination);
    response.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_UPDATE_INSTALLER_BYTES) {
        const error = new Error('L’installateur téléchargé dépasse la taille autorisée.');
        response.destroy(error);
        output.destroy(error);
      }
    });
    response.once('error', reject);
    output.once('error', reject);
    output.once('finish', resolve);
    response.pipe(output);
  });
}

async function downloadAndVerifyUpdate(update) {
  const checksumText = await fetchHttpsText(update.checksumUrl, { 'User-Agent': `Overlay-RL/${app.getVersion()}` }, 4096);
  const expectedHash = checksumText.trim().match(/^([a-f\d]{64})\b/i)?.[1]?.toLowerCase();
  if (!expectedHash) throw new Error('Le fichier de vérification SHA-256 est absent ou invalide.');

  fs.mkdirSync(LOCAL_UPDATE_DIR, { recursive: true });
  const partialPath = path.join(LOCAL_UPDATE_DIR, 'Rally-Update.exe.download');
  const installerPath = path.join(LOCAL_UPDATE_DIR, 'Rally-Update.exe');
  try {
    await downloadHttpsFile(update.installerUrl, partialPath);
    const hash = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(partialPath)) hash.update(chunk);
    if (hash.digest('hex').toLowerCase() !== expectedHash) {
      throw new Error('La vérification de sécurité de l’installateur a échoué.');
    }
    fs.rmSync(installerPath, { force: true });
    fs.renameSync(partialPath, installerPath);
    return installerPath;
  } catch (error) {
    fs.rmSync(partialPath, { force: true });
    throw error;
  }
}

async function checkForUpdate() {
  if (!app.isPackaged) return false;

  let update = null;
  try {
    update = await findGitHubUpdate();
  } catch (error) {
    if (error.statusCode !== 404) console.warn('Vérification de mise à jour GitHub impossible :', error.message);
  }
  const localUpdate = localUpdateManifest();
  if (!update || (localUpdate && compareVersions(localUpdate.version, update.version) > 0)) {
    update = localUpdate;
  }
  if (!update) return false;

  const choice = await dialog.showMessageBox({
    type: 'info',
    title: 'Mise à jour d’Overlay RL',
    message: `Overlay RL ${update.version} est disponible.`,
    detail: update.source === 'github'
      ? 'La mise à jour sera téléchargée depuis GitHub, installée puis Overlay RL redémarrera.'
      : 'Overlay RL va se fermer, appliquer la mise à jour puis redémarrer.',
    buttons: ['Mettre à jour', 'Plus tard'],
    defaultId: 0,
    cancelId: 1
  });
  if (choice.response !== 0) return false;

  let installerPath = update.installerPath;
  if (update.source === 'github') {
    try {
      installerPath = await downloadAndVerifyUpdate(update);
    } catch (error) {
      dialog.showErrorBox('Téléchargement impossible', `Overlay RL n’a pas pu télécharger la mise à jour : ${error.message}`);
      return false;
    }
  }

  return new Promise((resolve) => {
    const installer = spawn(installerPath, ['/S'], { detached: true, stdio: 'ignore', windowsHide: true });
    installer.once('spawn', () => {
      installer.unref();
      quitting = true;
      app.quit();
      resolve(true);
    });
    installer.once('error', (error) => {
      dialog.showErrorBox('Mise à jour impossible', `Overlay RL n’a pas pu lancer la mise à jour : ${error.message}`);
      resolve(false);
    });
  });
}

function readState() {
  try {
    const saved = JSON.parse(fs.readFileSync(dataFile(), 'utf8'));
    const savedMmrMode = saved.settings?.mmrMode;
    state = {
      settings: { ...DEFAULT_STATE.settings, ...(saved.settings || {}) },
      session: { ...DEFAULT_STATE.session, ...(saved.session || {}) }
    };
    const savedOverlayPlaylist = String(saved.settings?.overlayPlaylistId || saved.settings?.playlistId || DEFAULT_STATE.settings.overlayPlaylistId);
    state.settings.overlayPlaylistId = TRACKED_PLAYLIST_IDS.includes(savedOverlayPlaylist)
      ? savedOverlayPlaylist
      : DEFAULT_STATE.settings.overlayPlaylistId;
    state.settings.mmrByPlaylist = saved.settings?.mmrByPlaylist && typeof saved.settings.mmrByPlaylist === 'object'
      ? saved.settings.mmrByPlaylist
      : {};
    state.settings.rankByPlaylist = saved.settings?.rankByPlaylist && typeof saved.settings.rankByPlaylist === 'object'
      ? saved.settings.rankByPlaylist
      : {};
    state.settings.mmrMode = 'tracker';
    state.settings.sessionGoalMmr = normalizeSessionGoalMmr(saved.settings?.sessionGoalMmr);
    state.settings.overlayLayout = normalizeOverlayLayout(saved.settings?.overlayLayout);
    state.settings.overlayScale = normalizeOverlayScale(saved.settings?.overlayScale);
    state.settings.overlayOffsetX = normalizeOverlayOffset(saved.settings?.overlayOffsetX);
    state.settings.overlayOffsetY = normalizeOverlayOffset(saved.settings?.overlayOffsetY);
    state.settings.overlayStyle = normalizeOverlayStyle(saved.settings?.overlayStyle);
    state.settings.overlayOpacity = normalizeOverlayOpacity(saved.settings?.overlayOpacity);
    state.settings.overlayBounds = normalizeOverlayBounds(saved.settings?.overlayBounds);
    // Placement mode is opt-in for each launch so the overlay stays click-through by default.
    state.settings.overlayMovable = false;
    state.settings.overlayVisible = true;
    state.settings.controllerOverlayScale = normalizeControllerOverlayScale(saved.settings?.controllerOverlayScale);
    state.settings.controllerOverlayVisible = false;
    state.settings.controllerOverlayBounds = saved.settings?.controllerOverlayBounds
      && Number.isFinite(Number(saved.settings.controllerOverlayBounds.x))
      && Number.isFinite(Number(saved.settings.controllerOverlayBounds.y))
      ? saved.settings.controllerOverlayBounds
      : null;
    // Always start click-through; placement mode must be requested for each launch.
    state.settings.controllerOverlayMovable = false;
    if (savedMmrMode !== 'tracker') state.session = structuredClone(DEFAULT_STATE.session);
  } catch {
    state = structuredClone(DEFAULT_STATE);
  }
}

function persistState() {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(dataFile(), JSON.stringify(state, null, 2), 'utf8');
  broadcast('app:stateChanged', state);
  positionOverlay();
}

function broadcast(channel, payload) {
  for (const window of [mainWindow, overlayWindow]) {
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
  }
}

function updateConnection(next) {
  const updated = { ...connection, ...next };
  if (JSON.stringify(updated) === JSON.stringify(connection)) return;
  connection = updated;
  broadcast('game:connection', connection);
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 780,
    minWidth: 1024,
    minHeight: 680,
    frame: false,
    backgroundColor: '#07101d',
    title: 'Overlay RL',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
    if (process.platform !== 'darwin' && !quitting) app.quit();
  });
}

function createOverlayWindow() {
  const scale = normalizeOverlayScale(state.settings.overlayScale) / 100;
  const { width, height } = overlayLayoutSize(state.settings.overlayLayout);
  overlayWindow = new BrowserWindow({
    width: Math.round(width * scale),
    height: Math.round(height * scale),
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));
  overlayWindow.once('ready-to-show', () => {
    if (state.settings.overlayVisible) overlayWindow.showInactive();
  });
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.on('move', () => {
    if (!state.settings.overlayMovable) return;
    clearTimeout(overlayBoundsTimer);
    overlayBoundsTimer = setTimeout(() => {
      if (!overlayWindow || overlayWindow.isDestroyed()) return;
      const bounds = overlayWindow.getBounds();
      state.settings.overlayBounds = { x: bounds.x, y: bounds.y };
      persistState();
    }, 180);
  });
  overlayWindow.on('closed', () => {
    overlayWindow = null;
    clearTimeout(overlayBoundsTimer);
  });
  applyOverlayInteraction();
  positionOverlay();
}

function controllerOverlayBounds() {
  const scale = normalizeControllerOverlayScale(state.settings.controllerOverlayScale) / 100;
  const width = Math.round(CONTROLLER_OVERLAY_BASE_WIDTH * scale);
  const height = Math.round(CONTROLLER_OVERLAY_BASE_HEIGHT * scale);
  const saved = state.settings.controllerOverlayBounds;
  const display = saved
    ? screen.getDisplayNearestPoint({ x: Number(saved.x) + width / 2, y: Number(saved.y) + height / 2 })
    : screen.getPrimaryDisplay();
  const area = display.workArea;
  const x = saved && Number.isFinite(Number(saved.x)) ? Number(saved.x) : area.x + 24;
  const y = saved && Number.isFinite(Number(saved.y))
    ? Number(saved.y)
    : area.y + area.height - height - 24;
  return {
    x: Math.max(area.x, Math.min(x, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(y, area.y + area.height - height)),
    width,
    height
  };
}

function normalizeControllerOverlayScale(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 100;
  const clamped = Math.min(CONTROLLER_OVERLAY_MAX_SCALE, Math.max(CONTROLLER_OVERLAY_MIN_SCALE, parsed));
  return Math.round(clamped / 5) * 5;
}

function applyControllerOverlayInteraction() {
  if (!controllerWindow || controllerWindow.isDestroyed()) return;
  const movable = Boolean(state.settings.controllerOverlayMovable);
  controllerWindow.setFocusable(movable);
  controllerWindow.setIgnoreMouseEvents(!movable, { forward: true });
}

function createControllerOverlayWindow() {
  controllerWindow = new BrowserWindow({
    ...controllerOverlayBounds(),
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  controllerWindow.webContents.setBackgroundThrottling(false);
  controllerWindow.loadFile(path.join(__dirname, 'controller.html'));
  controllerWindow.setIgnoreMouseEvents(true, { forward: true });
  controllerWindow.setAlwaysOnTop(true, 'screen-saver');
  controllerWindow.once('ready-to-show', () => {
    if (state.settings.controllerOverlayVisible) controllerWindow.showInactive();
  });
  controllerWindow.on('move', () => {
    if (!state.settings.controllerOverlayMovable) return;
    clearTimeout(controllerBoundsTimer);
    controllerBoundsTimer = setTimeout(() => {
      if (!controllerWindow || controllerWindow.isDestroyed()) return;
      const bounds = controllerWindow.getBounds();
      state.settings.controllerOverlayBounds = { x: bounds.x, y: bounds.y };
      persistState();
    }, 180);
  });
  controllerWindow.on('closed', () => { controllerWindow = null; });
}

function applyOverlayInteraction() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const movable = Boolean(state.settings.overlayMovable);
  overlayWindow.setFocusable(movable);
  overlayWindow.setIgnoreMouseEvents(!movable, { forward: true });
}

function positionOverlay() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const display = screen.getPrimaryDisplay();
  const { x, y, width, height } = display.workArea;
  const scale = normalizeOverlayScale(state.settings.overlayScale) / 100;
  const layoutSize = overlayLayoutSize(state.settings.overlayLayout);
  const overlayWidth = Math.round(layoutSize.width * scale);
  const overlayHeight = Math.round(layoutSize.height * scale);
  const size = overlayWindow.getSize();
  if (size[0] !== overlayWidth || size[1] !== overlayHeight) overlayWindow.setSize(overlayWidth, overlayHeight);
  const bounds = normalizeOverlayBounds(state.settings.overlayBounds);
  let requestedX;
  let requestedY;
  if (bounds) {
    requestedX = bounds.x;
    requestedY = bounds.y;
  } else {
    const margin = 22;
    const corner = state.settings.overlayCorner || 'top-right';
    const left = corner.endsWith('left');
    const top = corner.startsWith('top');
    const offsetX = normalizeOverlayOffset(state.settings.overlayOffsetX);
    const offsetY = normalizeOverlayOffset(state.settings.overlayOffsetY);
    requestedX = (left ? x + margin : x + width - overlayWidth - margin) + offsetX;
    requestedY = (top ? y + margin : y + height - overlayHeight - margin) + offsetY;
  }
  const xPos = Math.max(x, Math.min(requestedX, x + width - overlayWidth));
  const yPos = Math.max(y, Math.min(requestedY, y + height - overlayHeight));
  overlayWindow.setPosition(Math.round(xPos), Math.round(yPos));
}

function safeInt(value, fallback = 0) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function localIdentityKey(primaryId) {
  const parts = String(primaryId || '').split('|');
  return parts.length >= 2 ? `${parts[0].trim().toLowerCase()}|${parts[1].trim().toLowerCase()}` : '';
}

function getActiveSteamIdentity() {
  if (process.platform !== 'win32') return null;
  try {
    const output = execFileSync('reg.exe', [
      'query', 'HKCU\\Software\\Valve\\Steam\\ActiveProcess', '/v', 'ActiveUser'
    ], { encoding: 'utf8', windowsHide: true, timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] });
    const match = output.match(/ActiveUser\s+REG_DWORD\s+0x([a-f0-9]+)/i);
    if (!match) return null;
    const accountId = BigInt(`0x${match[1]}`);
    if (accountId <= 0n) return null;
    const steamId64 = 76561197960265728n + accountId;
    return { accountId: accountId.toString(), steamId64: steamId64.toString() };
  } catch {
    return null;
  }
}

function getLocalPrimaryIds() {
  if (Date.now() - localIdsScannedAt < 30000) return cachedLocalIds;
  localIdsScannedAt = Date.now();
  const ids = new Set();
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const epicDataDir = path.join(localAppData, 'EpicGamesLauncher', 'Saved', 'Data');
    try {
      for (const file of fs.readdirSync(epicDataDir)) {
        const accountId = file.match(/^([a-f0-9]{32})\.dat$/i)?.[1];
        if (accountId) ids.add(`epic|${accountId.toLowerCase()}`);
      }
    } catch {}
  }

  const activeSteam = getActiveSteamIdentity();
  if (activeSteam) {
    ids.add(`steam|${activeSteam.accountId}`);
    ids.add(`steam|${activeSteam.steamId64}`);
  }

  const home = app.getPath('home');
  const steamConfigFiles = new Set([
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Steam', 'config', 'loginusers.vdf'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Steam', 'config', 'loginusers.vdf'),
    path.join(home, 'AppData', 'Local', 'Steam', 'config', 'loginusers.vdf')
  ]);
  if (state.settings.installPath) {
    steamConfigFiles.add(path.resolve(state.settings.installPath, '..', '..', '..', 'config', 'loginusers.vdf'));
  }
  for (const file of steamConfigFiles) {
    try {
      const text = fs.readFileSync(file, 'utf8');
      for (const match of text.matchAll(/"(\d{17})"\s*\{([\s\S]*?)\}/g)) {
        const steamId = match[1];
        let accountId;
        try { accountId = (BigInt(steamId) - 76561197960265728n).toString(); } catch { continue; }
        if (activeSteam) {
          if (steamId !== activeSteam.steamId64 && accountId !== activeSteam.accountId) continue;
        } else if (!/"MostRecent"\s+"1"/i.test(match[2])) {
          continue;
        }
        ids.add(`steam|${steamId}`);
        if (BigInt(accountId) > 0n) ids.add(`steam|${accountId}`);
      }
    } catch {}
  }
  cachedLocalIds = ids;
  return ids;
}

function identifyLocalPlayer(players, refreshIdleMmr = true) {
  if (!Array.isArray(players) || !players.length) return null;
  const existing = state.settings.playerId && players.find((player) => player.id === state.settings.playerId);
  if (existing) {
    if (refreshIdleMmr && !state.session.active && !lastIdleMmrSyncAt) scheduleIdleMmrSync();
    return existing;
  }

  const localIds = getLocalPrimaryIds();
  const matches = players.filter((player) => localIds.has(localIdentityKey(player.id)));
  if (!matches.length) return null;
  const player = matches.find((entry) => entry.id.endsWith('|0')) || matches[0];
  if (state.settings.playerId !== player.id || state.settings.playerName !== player.name) {
    state.settings.playerId = player.id;
    state.settings.playerName = player.name;
    persistState();
  }
  if (player.teamNum !== null) localTeamNum = player.teamNum;
  updateConnection({ message: 'Ton compte a été reconnu automatiquement', trackerMessage: 'Compte détecté — lecture automatique du MMR…' });
  if (refreshIdleMmr) scheduleIdleMmrSync();
  return player;
}

function applyMatchResult(result, matchGuid) {
  if (!state.session.active || !['win', 'loss'].includes(result)) return;
  if (matchGuid && seenMatches.has(matchGuid)) return;
  if (matchGuid) {
    seenMatches.add(matchGuid);
    if (seenMatches.size > 40) seenMatches.delete(seenMatches.values().next().value);
  }

  const session = state.session;
  if (result === 'win') session.wins += 1;
  else session.losses += 1;

  if (session.streakType === result) session.streakCount += 1;
  else {
    session.streakType = result;
    session.streakCount = 1;
  }

  const isTrackerMode = state.settings.mmrMode === 'tracker';
  const mmrChange = state.settings.mmrMode === 'estimate'
    ? (result === 'win' ? safeInt(state.settings.winMmr, 9) : -safeInt(state.settings.lossMmr, 9))
    : isTrackerMode ? null : 0;
  if (!isTrackerMode) {
    if (session.currentMmr === null || session.currentMmr === undefined) session.currentMmr = 0;
    session.currentMmr += mmrChange;
  }
  session.history.unshift({
    result,
    mmrChange,
    mmr: session.currentMmr,
    matchGuid,
    trackerPending: isTrackerMode,
    at: new Date().toISOString()
  });
  session.history = session.history.slice(0, 12);
  persistState();
  if (isTrackerMode) scheduleTrackerSync(session.startedAt);
}

function requestTrackerStatsViaRelay(primaryId, displayName) {
  return new Promise((resolve, reject) => {
    const encodedId = encodeURIComponent(primaryId);
    const url = new URL(`${TRACKER_RELAY}/player/${encodedId}/ranks`);
    if (displayName) url.searchParams.set('name', displayName);
    const request = https.get(url, { headers: { 'User-Agent': `Rally-RL-Session/${app.getVersion()}` } }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(response.statusCode === 404 ? 'Aucun profil ou MMR trouvé pour ce compte.' : `Le relais Tracker a répondu HTTP ${response.statusCode}.`));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error('La réponse du relais Tracker est illisible.')); }
      });
    });
    request.setTimeout(TRACKER_TIMEOUT_MS, () => request.destroy(new Error('Délai dépassé en contactant le relais Tracker.')));
    request.on('error', reject);
  });
}

async function requestTrackerStatsDirect(primaryId, displayName) {
  const [platform, identifier] = String(primaryId || '').split('|', 2);
  if (String(platform || '').toLowerCase() !== 'steam' || !/^7656119\d{10}$/.test(identifier || '')) {
    throw new Error('Le compte Steam détecté ne contient pas un SteamID64 valide.');
  }

  const url = `https://api.tracker.gg/api/v2/rocket-league/standard/profile/steam/${encodeURIComponent(identifier)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRACKER_TIMEOUT_MS);
  try {
    const response = await net.fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json, text/plain, */*',
        Origin: 'https://rocketleague.tracker.network',
        Referer: 'https://rocketleague.tracker.network/',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    if (response.status === 404) throw new Error('Tracker ne trouve pas le profil Steam.');
    if (!response.ok) throw new Error(`Tracker a répondu HTTP ${response.status}.`);

    const payload = await response.json();
    const data = payload?.data;
    if (!data || !Array.isArray(data.segments)) throw new Error('La réponse directe de Tracker est incomplète.');
    const ranks = {};
    for (const segment of data.segments) {
      if (segment?.type !== 'playlist') continue;
      const playlistId = String(segment.attributes?.playlistId ?? '');
      const mmr = Number(segment.stats?.rating?.value);
      if (!playlistId || !Number.isFinite(mmr)) continue;
      const tier = segment.stats?.tier || {};
      const division = segment.stats?.division || {};
      const divisionMetadata = division.metadata || {};
      ranks[playlistId] = {
        mmr: Math.round(mmr),
        tierName: tier.metadata?.name || tier.metadata?.displayName || '',
        tierIndex: tier.value !== null && tier.value !== undefined && Number.isFinite(Number(tier.value)) ? Number(tier.value) : null,
        divisionName: divisionMetadata.name || divisionMetadata.displayName || '',
        divisionIndex: division.value !== null && division.value !== undefined && Number.isFinite(Number(division.value)) ? Number(division.value) : null,
        deltaUp: divisionMetadata.deltaUp !== null && divisionMetadata.deltaUp !== undefined && Number.isFinite(Number(divisionMetadata.deltaUp)) ? Number(divisionMetadata.deltaUp) : null,
        deltaDown: divisionMetadata.deltaDown !== null && divisionMetadata.deltaDown !== undefined && Number.isFinite(Number(divisionMetadata.deltaDown)) ? Number(divisionMetadata.deltaDown) : null
      };
    }
    return {
      ranks,
      display_name: data.platformInfo?.platformUserHandle || displayName || 'profil Tracker'
    };
  } finally {
    clearTimeout(timer);
  }
}

async function requestTrackerStats(primaryId, displayName, playlistId) {
  let directData = null;
  let directError = null;
  if (String(primaryId || '').toLowerCase().startsWith('steam|')) {
    try {
      directData = await requestTrackerStatsDirect(primaryId, displayName);
      if (directData.ranks[String(playlistId)]) return directData;
    } catch (error) {
      directError = error;
    }
  }

  try {
    return await requestTrackerStatsViaRelay(primaryId, displayName);
  } catch (relayError) {
    if (directData) return directData;
    if (directError) {
      throw new Error(`Tracker direct : ${directError.message} · relais : ${relayError.message}`);
    }
    throw relayError;
  }
}

async function fetchTrackerMmr(playlistIdOverride) {
  const { playerId, playerName } = state.settings;
  const requestedPlaylist = String(playlistIdOverride || state.settings.playlistId || DEFAULT_STATE.settings.playlistId);
  const playlistId = TRACKED_PLAYLIST_IDS.includes(requestedPlaylist) ? requestedPlaylist : DEFAULT_STATE.settings.playlistId;
  if (!playerId) throw new Error('Identifie ton joueur dans Rocket League avant de synchroniser le MMR.');
  updateConnection({ trackerMessage: 'Synchronisation du MMR…' });
  try {
    const data = await requestTrackerStats(playerId, playerName, playlistId);
    const nextMmrByPlaylist = { ...state.settings.mmrByPlaylist };
    const nextRankByPlaylist = { ...state.settings.rankByPlaylist };
    let ranksChanged = false;
    for (const trackedId of TRACKED_PLAYLIST_IDS) {
      const trackedRank = RallyRanks.normalizeRank(data?.ranks?.[trackedId]);
      const trackedMmr = trackedRank?.mmr;
      if (trackedMmr === null || trackedMmr === undefined || !Number.isFinite(Number(trackedMmr))) continue;
      const roundedMmr = Math.round(trackedMmr);
      if (Number(nextMmrByPlaylist[trackedId]) !== roundedMmr) {
        nextMmrByPlaylist[trackedId] = roundedMmr;
        ranksChanged = true;
      }
      if (trackedRank && (trackedRank.tierName || trackedRank.tierIndex !== null || trackedRank.pointsToNext !== null)) {
        const savedRank = {
          tierName: trackedRank.tierName,
          tierIndex: trackedRank.tierIndex,
          divisionName: trackedRank.divisionName,
          divisionIndex: trackedRank.divisionIndex,
          deltaUp: trackedRank.deltaUp,
          deltaDown: trackedRank.deltaDown,
          pointsToNext: trackedRank.pointsToNext,
          approximate: trackedRank.approximate,
          nextTierName: trackedRank.nextTierName,
          mmr: roundedMmr,
          updatedAt: new Date().toISOString()
        };
        if (JSON.stringify(nextRankByPlaylist[trackedId]) !== JSON.stringify(savedRank)) {
          nextRankByPlaylist[trackedId] = savedRank;
          ranksChanged = true;
        }
      }
    }
    if (ranksChanged) {
      state.settings.mmrByPlaylist = nextMmrByPlaylist;
      state.settings.rankByPlaylist = nextRankByPlaylist;
      persistState();
    }
    const rank = RallyRanks.normalizeRank(data?.ranks?.[String(playlistId)]);
    const mmr = rank?.mmr;
    if (mmr === null || mmr === undefined || !Number.isFinite(Number(mmr))) throw new Error('Aucun MMR trouvé pour ce mode de jeu. Vérifie le mode sélectionné et ton profil Tracker.');
    const playlistNames = { '10': '1v1', '11': '2v2', '13': '3v3' };
    updateConnection({ trackerMessage: `MMR ${playlistNames[playlistId]} synchronisé : ${Math.round(mmr)} · ${data.display_name || playerName || 'profil Tracker'}` });
    return { mmr: Math.round(mmr), displayName: data.display_name || playerName || '', playlistId, rank };
  } catch (error) {
    updateConnection({ trackerMessage: error.message || 'Échec de la synchronisation Tracker.' });
    throw error;
  }
}

function syncIdleMmrNow() {
  if (!state.settings.playerId || state.session.active || Date.now() - lastIdleMmrSyncAt < 60000) return;
  lastIdleMmrSyncAt = Date.now();
  fetchTrackerMmr().then(({ mmr }) => {
    if (state.session.active) return;
    state.session.currentMmr = mmr;
    persistState();
  }).catch(() => {});
}

function scheduleIdleMmrSync() {
  if (idleMmrTimer) clearTimeout(idleMmrTimer);
  syncIdleMmrNow();
  idleMmrTimer = setTimeout(() => {
    idleMmrTimer = null;
    scheduleIdleMmrSync();
  }, 10 * 60 * 1000);
  if (typeof idleMmrTimer.unref === 'function') idleMmrTimer.unref();
}

function startAutomaticSession(playlistId, matchGuid) {
  const playlist = String(playlistId || '');
  if (!matchGuid || !['10', '11', '13'].includes(playlist) || !state.settings.playerId) return;
  if (state.session.active && String(state.session.playlistId || '') === playlist) return;
  if (autoStartMatchGuid === matchGuid) return;

  autoStartMatchGuid = matchGuid;
  state.settings.playlistId = playlist;
  state.session = {
    ...DEFAULT_STATE.session,
    active: true,
    startMmr: null,
    currentMmr: null,
    startedAt: new Date().toISOString(),
    playlistId: playlist,
    auto: true,
    history: []
  };
  if (idleMmrTimer) clearTimeout(idleMmrTimer);
  idleMmrTimer = null;
  persistState();
  updateConnection({ trackerMessage: 'Lecture du MMR avant le match…', message: 'Suivi automatique démarré' });

  const sessionStartedAt = state.session.startedAt;
  baselineSyncSessionStartedAt = '';
  baselineSyncAttemptAt = 0;
  syncSessionMmrBaseline(sessionStartedAt);
}

function syncSessionMmrBaseline(sessionStartedAt) {
  if (!state.session.active || state.session.startedAt !== sessionStartedAt || (state.session.startMmr !== null && state.session.startMmr !== undefined)) return;
  if (!state.settings.playerId) return;
  if (baselineSyncSessionStartedAt !== sessionStartedAt) {
    baselineSyncSessionStartedAt = sessionStartedAt;
    baselineSyncAttemptAt = 0;
  }
  if (Date.now() - baselineSyncAttemptAt < 60000) return;
  baselineSyncAttemptAt = Date.now();

  fetchTrackerMmr().then(({ mmr }) => {
    if (!state.session.active || state.session.startedAt !== sessionStartedAt || (state.session.startMmr !== null && state.session.startMmr !== undefined)) return;
    state.session.startMmr = mmr;
    state.session.currentMmr = mmr;
    persistState();
  }).catch(() => {
    if (!state.session.active || state.session.startedAt !== sessionStartedAt || (state.session.startMmr !== null && state.session.startMmr !== undefined)) return;
    const retryTimer = setTimeout(() => syncSessionMmrBaseline(sessionStartedAt), 65000);
    if (typeof retryTimer.unref === 'function') retryTimer.unref();
  });
}

function median(values) {
  const sorted = (Array.isArray(values) ? values : [])
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function applyTrackerReading(mmr, finalizeUnchanged = false) {
  if (!state.session.active) return;
  const hasPreviousMmr = state.session.currentMmr !== null && state.session.currentMmr !== undefined && Number.isFinite(Number(state.session.currentMmr));
  const previousMmr = hasPreviousMmr ? Number(state.session.currentMmr) : null;
  const delta = hasPreviousMmr ? mmr - previousMmr : null;
  if (state.session.startMmr === null || state.session.startMmr === undefined) state.session.startMmr = mmr;
  state.session.currentMmr = mmr;
  const pending = state.session.history
    .filter((entry) => entry.trackerPending)
    .sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
  if (!hasPreviousMmr && pending.length) {
    for (const entry of pending) {
      entry.trackerPending = false;
      entry.trackerUnavailable = true;
      entry.mmrEstimated = false;
      entry.mmr = mmr;
    }
    updateConnection({ trackerMessage: 'MMR reçu ; le premier delta n’était pas disponible.' });
  } else if (pending.length && (delta !== 0 || finalizeUnchanged)) {
    const session = state.session;
    session.mmrStepHistory = Array.isArray(session.mmrStepHistory) ? session.mmrStepHistory : [];
    if (pending.length === 1) {
      const entry = pending[0];
      entry.mmrChange = delta;
      entry.mmrEstimated = Boolean(finalizeUnchanged && delta === 0);
      if (entry.mmrEstimated) entry.mmrEstimateMethod = 'unchanged-snapshot';
      entry.mmrCoveredMatches = 1;
      entry.trackerPending = false;
      entry.mmr = mmr;
      session.mmrStepHistory.push(Math.abs(delta));
      session.mmrStepHistory = session.mmrStepHistory.slice(-20);
      updateConnection({ trackerMessage: entry.mmrEstimated
        ? 'Aucun changement MMR détecté après 15 min ; valeur estimée à 0.'
        : `MMR confirmé après le match : ${delta > 0 ? '+' : ''}${delta}.` });
    } else {
      const wins = pending.filter((entry) => entry.result === 'win').length;
      const netWins = wins - (pending.length - wins);
      const deltaMatchesOutcome = netWins !== 0 && Math.sign(delta) === Math.sign(netWins);
      const previousStep = median(session.mmrStepHistory);
      const step = deltaMatchesOutcome ? Math.abs(delta) / Math.abs(netWins) : (previousStep || 9);
      const estimateMethod = deltaMatchesOutcome ? 'net-results' : previousStep ? 'past-median' : 'default-step';
      let estimatedTotal = 0;
      let rawTotal = 0;
      let runningMmr = previousMmr;

      pending.forEach((entry, index) => {
        let change;
        if (index === pending.length - 1) {
          // Reconcile the final point to Tracker's actual snapshot.
          change = delta - estimatedTotal;
        } else {
          rawTotal += (entry.result === 'win' ? 1 : -1) * step;
          const nextEstimatedTotal = Math.round(rawTotal);
          change = nextEstimatedTotal - estimatedTotal;
          estimatedTotal = nextEstimatedTotal;
        }
        runningMmr += change;
        entry.mmrChange = change;
        entry.mmrEstimated = true;
        entry.mmrEstimateMethod = finalizeUnchanged && delta === 0 ? 'unchanged-snapshot' : estimateMethod;
        entry.mmrCoveredMatches = pending.length;
        entry.trackerPending = false;
        entry.mmr = index === pending.length - 1 ? mmr : runningMmr;
      });

      if (deltaMatchesOutcome) {
        session.mmrStepHistory.push(step);
        session.mmrStepHistory = session.mmrStepHistory.slice(-20);
      }
      const prefix = delta > 0 ? '+' : '';
      updateConnection({ trackerMessage: finalizeUnchanged && delta === 0
        ? `MMR total inchangé après 15 min ; répartition estimée sur ${pending.length} matchs.`
        : `MMR total synchronisé (${prefix}${delta} sur ${pending.length} matchs) ; détails par match estimés.` });
    }
  }
  persistState();
}

function scheduleTrackerSync(sessionStartedAt) {
  if (trackerSyncRunning) return;
  trackerSyncRunning = true;
  let retryAgain = false;
  let lastSuccessfulMmr = null;
  const checkAtMs = [15000, 60000, 120000, 240000, 360000, 540000, 720000, 900000];
  const scheduledAt = Date.now();
  (async () => {
    try {
      for (const targetMs of checkAtMs) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, Math.max(0, targetMs - (Date.now() - scheduledAt)));
          if (typeof timer.unref === 'function') timer.unref();
        });
        if (!state.session.active || state.session.startedAt !== sessionStartedAt) return;
        if (!state.session.history.some((entry) => entry.trackerPending)) return;
        try {
          const reading = await fetchTrackerMmr();
          if (!state.session.active || state.session.startedAt !== sessionStartedAt) return;
          const before = Number(state.session.currentMmr);
          lastSuccessfulMmr = reading.mmr;
          if (reading.mmr !== before) {
            applyTrackerReading(reading.mmr);
            return;
          }
        } catch {
          // Retry later; Tracker's cached profile may not have updated yet.
        }
      }
      if (state.session.active && state.session.startedAt === sessionStartedAt) {
        const pending = state.session.history.filter((entry) => entry.trackerPending);
        if (pending.length && lastSuccessfulMmr !== null) {
          const netWins = pending.reduce((total, entry) => total + (entry.result === 'win' ? 1 : -1), 0);
          // A single unchanged snapshot can only support a cautious 0 estimate. For
          // several matches, finalize 0 only when wins and losses balance; otherwise
          // keep retrying because Tracker may still be stale.
          if (pending.length === 1 || netWins === 0) applyTrackerReading(lastSuccessfulMmr, true);
        }
        retryAgain = state.session.history.some((entry) => entry.trackerPending);
        updateConnection({ trackerMessage: retryAgain ? 'Le relais tarde ; Overlay RL continuera la synchronisation automatiquement.' : 'MMR synchronisé.' });
      }
    } finally {
      trackerSyncRunning = false;
      if (retryAgain && state.session.active && state.session.startedAt === sessionStartedAt) {
        const timer = setTimeout(() => scheduleTrackerSync(sessionStartedAt), 120000);
        if (typeof timer.unref === 'function') timer.unref();
      }
    }
  })();
}

function handleGameMessage(raw) {
  let packet;
  try { packet = JSON.parse(raw.toString()); } catch { return; }
  let data = packet && packet.Data;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { return; }
  }
  if (!data || typeof data !== 'object') return;

  if (packet.Event === 'UpdateState') {
    const players = Array.isArray(data.Players) ? data.Players.map((player) => ({
      name: String(player.Name || 'Joueur'),
      id: String(player.PrimaryId || ''),
      teamNum: Number.isFinite(player.TeamNum) ? player.TeamNum : null
    })) : [];
    const gameGuid = String(data.MatchGuid || '');
    const playlistId = safeInt(data.Game?.PlaylistId, -1);
    const trackedPlaylistId = ['10', '11', '13'].includes(String(playlistId)) ? String(playlistId) : '';
    const me = identifyLocalPlayer(players, !(gameGuid && trackedPlaylistId));
    if (gameGuid && gameGuid !== lastGameGuid) {
      lastGameGuid = gameGuid;
      localTeamNum = null;
    }
    if (me && me.teamNum !== null) localTeamNum = me.teamNum;
    updateConnection({
      connected: true,
      players,
      playlistId: trackedPlaylistId,
      gameActive: Boolean(gameGuid),
      message: me ? 'Compte local reconnu automatiquement' : (players.length ? 'Recherche de ton compte local…' : 'Connecté à Rocket League')
    });
    if (gameGuid && trackedPlaylistId && me) {
      if (state.session.active && String(state.session.playlistId || '') === trackedPlaylistId) {
        if (state.session.startMmr === null) syncSessionMmrBaseline(state.session.startedAt);
      } else {
        startAutomaticSession(trackedPlaylistId, gameGuid);
      }
    }
    return;
  }

  if (packet.Event === 'MatchCreated') {
    lastGameGuid = String(data.MatchGuid || lastGameGuid);
    localTeamNum = null;
    roundStarted = false;
    replayLoaded = false;
    updateConnection({ connected: true, gameActive: true, message: 'Match en cours' });
    return;
  }

  if (packet.Event === 'RoundStarted') {
    roundStarted = true;
    return;
  }

  if (packet.Event === 'ReplayCreated') {
    replayLoaded = true;
    return;
  }

  if (packet.Event === 'MatchDestroyed') {
    updateConnection({ gameActive: false, playlistId: '', message: connection.connected ? 'Connecté — en attente du prochain match classé' : connection.message });
    localTeamNum = null;
    lastGameGuid = '';
    roundStarted = false;
    replayLoaded = false;
    return;
  }

  if (packet.Event === 'MatchEnded') {
    if (!roundStarted || replayLoaded) {
      updateConnection({ connected: true, gameActive: false, message: 'Match annulé ou replay ignoré' });
      return;
    }
    const winnerTeamNum = safeInt(data.WinnerTeamNum, -1);
    const matchGuid = String(data.MatchGuid || lastGameGuid);
    const player = connection.players.find((entry) => entry.id === state.settings.playerId);
    if (player && player.teamNum !== null) localTeamNum = player.teamNum;
    if (localTeamNum !== null && winnerTeamNum >= 0) {
      applyMatchResult(winnerTeamNum === localTeamNum ? 'win' : 'loss', matchGuid);
      updateConnection({ connected: true, gameActive: false, message: 'Résultat reçu automatiquement' });
    } else {
      updateConnection({ connected: true, gameActive: false, message: 'Résultat reçu — joueur à identifier' });
    }
  }
}

function connectStatsSocket() {
  if (quitting || statsSocket) return;
  updateConnection({ connected: false, message: 'En attente de Rocket League…' });
  const socket = new WebSocket(STATS_WS_URL);
  statsSocket = socket;
  socket.on('open', () => updateConnection({ connected: true, message: 'Connecté à Rocket League' }));
  socket.on('message', handleGameMessage);
  socket.on('error', () => {});
  socket.on('close', () => {
    if (statsSocket === socket) statsSocket = null;
    updateConnection({ connected: false, gameActive: false, message: 'En attente de Rocket League…' });
    if (!quitting) reconnectTimer = setTimeout(connectStatsSocket, 3000);
  });
}

function updateIniContent(existing) {
  const sectionName = '[TAGame.MatchStatsExporter_TA]';
  const values = { PacketSendRate: '2', Port: '49123', WebPort: '49124' };
  const lines = existing.replace(/\r\n/g, '\n').split('\n');
  let sectionStart = lines.findIndex((line) => /^\s*\[TAGame\.MatchStatsExporter_TA\]\s*$/i.test(line));
  if (sectionStart < 0) {
    if (lines.some((line) => line.trim())) lines.push('');
    sectionStart = lines.length;
    lines.push(sectionName);
  }
  let sectionEnd = sectionStart + 1;
  while (sectionEnd < lines.length && !/^\s*\[[^\]]+\]\s*$/.test(lines[sectionEnd])) sectionEnd += 1;
  const seen = new Set();
  for (let i = sectionEnd - 1; i > sectionStart; i -= 1) {
    const match = lines[i].match(/^\s*(PacketSendRate|Port|WebPort)\s*=/i);
    if (!match) continue;
    const key = Object.keys(values).find((candidate) => candidate.toLowerCase() === match[1].toLowerCase());
    if (seen.has(key)) {
      lines.splice(i, 1);
      sectionEnd -= 1;
    } else {
      seen.add(key);
      lines[i] = `${key}=${values[key]}`;
    }
  }
  for (const key of Object.keys(values)) {
    if (!seen.has(key)) lines.splice(sectionEnd++, 0, `${key}=${values[key]}`);
  }
  return `${lines.join('\r\n').replace(/(?:\r\n)+$/, '')}\r\n`;
}

function detectRocketLeagueInstall() {
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  const steamCandidates = [
    path.join(programFilesX86, 'Steam', 'steamapps', 'common', 'rocketleague'),
    path.join(programFiles, 'Steam', 'steamapps', 'common', 'rocketleague')
  ];
  const epicCandidates = [
    path.join(programFiles, 'Epic Games', 'rocketleague'),
    path.join(programFilesX86, 'Epic Games', 'rocketleague')
  ];

  const programData = process.env.ProgramData || 'C:\\ProgramData';
  const epicManifestDir = path.join(programData, 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests');
  try {
    for (const file of fs.readdirSync(epicManifestDir)) {
      if (!file.toLowerCase().endsWith('.item')) continue;
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(epicManifestDir, file), 'utf8'));
        const title = `${manifest.DisplayName || ''} ${manifest.AppName || ''}`;
        if (/rocket\s*league|rocketleague/i.test(title) && manifest.InstallLocation) epicCandidates.push(manifest.InstallLocation);
      } catch {}
    }
  } catch {}

  const steamRoots = new Set([
    path.join(programFilesX86, 'Steam'),
    path.join(programFiles, 'Steam')
  ]);
  for (const root of steamRoots) {
    try {
      const libraryFile = path.join(root, 'steamapps', 'libraryfolders.vdf');
      const text = fs.readFileSync(libraryFile, 'utf8');
      for (const match of text.matchAll(/"path"\s+"([^"]+)"/gi)) {
        const library = match[1].replace(/\\\\/g, '\\');
        steamCandidates.push(path.join(library, 'steamapps', 'common', 'rocketleague'));
      }
    } catch {}
  }

  const candidates = [];
  if (getActiveSteamIdentity()) candidates.push(...steamCandidates);
  if (state.settings.installPath) candidates.push(state.settings.installPath);
  candidates.push(...epicCandidates, ...steamCandidates);
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, 'TAGame', 'Config'))) || '';
}

function configureStatsApi(installPath = '') {
  const userConfig = path.join(app.getPath('documents'), 'My Games', 'Rocket League', 'TAGame', 'Config', 'TAStatsAPI.ini');
  fs.mkdirSync(path.dirname(userConfig), { recursive: true });
  const userPrevious = fs.existsSync(userConfig) ? fs.readFileSync(userConfig, 'utf8') : '';
  const userUpdated = updateIniContent(userPrevious);
  if (userUpdated !== userPrevious) fs.writeFileSync(userConfig, userUpdated, 'utf8');

  const installFiles = installPath
    ? ['TAStatsAPI.ini', 'DefaultStatsAPI.ini'].map((name) => path.join(installPath, 'TAGame', 'Config', name)).filter((file) => fs.existsSync(file))
    : [];
  if (installPath && !installFiles.length) installFiles.push(path.join(installPath, 'TAGame', 'Config', 'DefaultStatsAPI.ini'));
  const configuredInstallFiles = [];
  const installErrors = [];
  for (const file of installFiles) {
    try {
      const previous = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      const updated = updateIniContent(previous);
      if (updated !== previous) fs.writeFileSync(file, updated, 'utf8');
      configuredInstallFiles.push(file);
    } catch (error) {
      installErrors.push(`${path.basename(file)} : ${error.message}`);
    }
  }
  return {
    configFile: userConfig,
    installFiles: configuredInstallFiles,
    warning: installErrors.length ? `Fichier d’installation non modifié (${installErrors.join('; ')}).` : ''
  };
}

function configureStatsApiAutomatically() {
  const installPath = detectRocketLeagueInstall();
  try {
    const result = configureStatsApi(installPath);
    if (installPath && state.settings.installPath !== installPath) {
      state.settings.installPath = installPath;
      persistState();
    }
    updateConnection({ setupMessage: installPath ? 'Stats API configurée automatiquement — relance le jeu si nécessaire.' : 'Configuration automatique enregistrée — Rocket League doit être redémarré pour lire le fichier.' });
    if (result.warning) updateConnection({ setupMessage: result.warning });
  } catch (error) {
    updateConnection({ setupMessage: `Configuration automatique impossible : ${error.message}` });
  }
}

ipcMain.handle('state:load', () => state);
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('app:window:minimize', () => { mainWindow?.minimize(); return true; });
ipcMain.handle('app:window:toggleMaximize', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return mainWindow.isMaximized();
});
ipcMain.handle('app:window:close', () => { mainWindow?.close(); return true; });
ipcMain.handle('state:save', (_event, next) => {
  if (!next || typeof next !== 'object') return state;
  state = {
    settings: { ...DEFAULT_STATE.settings, ...(next.settings || {}) },
    session: { ...DEFAULT_STATE.session, ...(next.session || {}) }
  };
  const overlayPlaylistId = String(state.settings.overlayPlaylistId || DEFAULT_STATE.settings.overlayPlaylistId);
  state.settings.overlayPlaylistId = TRACKED_PLAYLIST_IDS.includes(overlayPlaylistId)
    ? overlayPlaylistId
    : DEFAULT_STATE.settings.overlayPlaylistId;
  state.settings.sessionGoalMmr = normalizeSessionGoalMmr(state.settings.sessionGoalMmr);
  state.settings.overlayLayout = normalizeOverlayLayout(state.settings.overlayLayout);
  state.settings.overlayScale = normalizeOverlayScale(state.settings.overlayScale);
  state.settings.overlayOffsetX = normalizeOverlayOffset(state.settings.overlayOffsetX);
  state.settings.overlayOffsetY = normalizeOverlayOffset(state.settings.overlayOffsetY);
  state.settings.overlayStyle = normalizeOverlayStyle(state.settings.overlayStyle);
  state.settings.overlayOpacity = normalizeOverlayOpacity(state.settings.overlayOpacity);
  state.settings.overlayBounds = normalizeOverlayBounds(state.settings.overlayBounds);
  state.settings.overlayMovable = Boolean(state.settings.overlayMovable);
  state.settings.mmrByPlaylist = state.settings.mmrByPlaylist && typeof state.settings.mmrByPlaylist === 'object'
    ? state.settings.mmrByPlaylist
    : {};
  state.settings.rankByPlaylist = state.settings.rankByPlaylist && typeof state.settings.rankByPlaylist === 'object'
    ? state.settings.rankByPlaylist
    : {};
  state.settings.controllerOverlayScale = normalizeControllerOverlayScale(state.settings.controllerOverlayScale);
  persistState();
  return state;
});
ipcMain.handle('game:connection', () => connection);
ipcMain.handle('controller:getStatus', () => controllerStatus);
ipcMain.on('controller:status', (_event, status) => {
  const next = {
    connected: Boolean(status?.connected),
    name: String(status?.name || '').slice(0, 96)
  };
  if (next.connected === controllerStatus.connected && next.name === controllerStatus.name) return;
  controllerStatus = next;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('controller:statusChanged', controllerStatus);
});
ipcMain.handle('tracker:open', async () => {
  await shell.openExternal('https://rocketleague.tracker.network/');
  return true;
});
ipcMain.handle('game:configureFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Choisir le dossier de Rocket League',
    properties: ['openDirectory', 'createDirectory']
  });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle('game:enableStatsApi', async (_event, installPath) => {
  if (typeof installPath !== 'string' || !installPath.trim()) throw new Error('Choisis le dossier d’installation du jeu.');
  const configFolder = path.join(installPath, 'TAGame', 'Config');
  if (!fs.existsSync(configFolder)) throw new Error('Ce dossier ne ressemble pas au dossier d’installation de Rocket League : TAGame\\Config est introuvable.');
  const result = configureStatsApi(installPath);
  state.settings.installPath = installPath;
  persistState();
  return result;
});
ipcMain.handle('overlay:setVisible', (_event, visible) => {
  if (!overlayWindow || overlayWindow.isDestroyed()) createOverlayWindow();
  if (visible) {
    positionOverlay();
    overlayWindow.showInactive();
  } else {
    overlayWindow.hide();
  }
  return Boolean(visible);
});
ipcMain.handle('overlay:setMovable', (_event, movable) => {
  state.settings.overlayMovable = Boolean(movable);
  if (state.settings.overlayMovable && (!overlayWindow || overlayWindow.isDestroyed())) createOverlayWindow();
  applyOverlayInteraction();
  if (state.settings.overlayMovable && overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.showInactive();
  persistState();
  return state;
});
ipcMain.handle('overlay:setCorner', (_event, corner) => {
  if (['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(corner)) {
    state.settings.overlayCorner = corner;
    // An explicit corner choice drops the free placement so the picker takes effect again.
    state.settings.overlayBounds = null;
    persistState();
  }
  return state.settings.overlayCorner;
});
ipcMain.handle('controllerOverlay:setVisible', (_event, visible) => {
  if (!controllerWindow || controllerWindow.isDestroyed()) createControllerOverlayWindow();
  state.settings.controllerOverlayVisible = Boolean(visible);
  if (!state.settings.controllerOverlayVisible) state.settings.controllerOverlayMovable = false;
  applyControllerOverlayInteraction();
  if (state.settings.controllerOverlayVisible) {
    controllerWindow.setBounds(controllerOverlayBounds());
    controllerWindow.showInactive();
  } else {
    controllerWindow.hide();
  }
  persistState();
  return state;
});
ipcMain.handle('controllerOverlay:setScale', (_event, scale) => {
  state.settings.controllerOverlayScale = normalizeControllerOverlayScale(scale);
  if (controllerWindow && !controllerWindow.isDestroyed()) {
    const bounds = controllerOverlayBounds();
    controllerWindow.setBounds(bounds);
    state.settings.controllerOverlayBounds = { x: bounds.x, y: bounds.y };
  }
  persistState();
  return state;
});
ipcMain.handle('controllerOverlay:setMovable', (_event, movable) => {
  state.settings.controllerOverlayMovable = Boolean(movable && state.settings.controllerOverlayVisible);
  applyControllerOverlayInteraction();
  if (state.settings.controllerOverlayVisible && controllerWindow && !controllerWindow.isDestroyed()) {
    controllerWindow.showInactive();
  }
  if (!state.settings.controllerOverlayMovable && controllerWindow && !controllerWindow.isDestroyed()) {
    const bounds = controllerWindow.getBounds();
    state.settings.controllerOverlayBounds = { x: bounds.x, y: bounds.y };
  }
  persistState();
  return state;
});
ipcMain.handle('session:record', (_event, result) => {
  applyMatchResult(result, `manual-${Date.now()}`);
  return state;
});
ipcMain.handle('session:start', (_event, mmr) => {
  if (state.settings.mmrMode === 'tracker') {
    return fetchTrackerMmr().then(({ mmr: trackerMmr }) => startSessionWithMmr(trackerMmr));
  }
  return startSessionWithMmr(safeInt(mmr, 0));
});
function startSessionWithMmr(startMmr) {
  state.session = {
    ...DEFAULT_STATE.session,
    active: true,
    startMmr,
    currentMmr: startMmr,
    startedAt: new Date().toISOString(),
    history: []
  };
  persistState();
  return state;
}
ipcMain.handle('tracker:fetchMmr', async (_event, playlistId) => {
  const result = await fetchTrackerMmr(playlistId);
  const sessionPlaylistId = String(state.session.playlistId || state.settings.playlistId || '');
  if (state.session.active && sessionPlaylistId === String(result.playlistId)) applyTrackerReading(result.mmr);
  return result;
});
ipcMain.handle('session:reset', () => {
  state.session = { ...DEFAULT_STATE.session, currentMmr: state.session.currentMmr };
  autoStartMatchGuid = '';
  persistState();
  scheduleIdleMmrSync();
  return state;
});
ipcMain.handle('session:clearStats', () => {
  if (!state.session.active) return state;
  const session = state.session;
  const hasCurrentMmr = session.currentMmr !== null && session.currentMmr !== undefined && Number.isFinite(Number(session.currentMmr));
  const currentMmr = hasCurrentMmr ? Number(session.currentMmr) : null;
  const startedAt = new Date().toISOString();
  state.session = {
    ...DEFAULT_STATE.session,
    active: true,
    startMmr: currentMmr,
    currentMmr,
    startedAt,
    playlistId: String(session.playlistId || state.settings.playlistId || '11'),
    auto: Boolean(session.auto),
    history: []
  };
  autoStartMatchGuid = '';
  baselineSyncSessionStartedAt = '';
  baselineSyncAttemptAt = 0;
  persistState();
  if (state.session.startMmr === null) syncSessionMmrBaseline(startedAt);
  return state;
});
ipcMain.handle('clipboard:writeText', (_event, text) => {
  clipboard.writeText(String(text || ''));
  return true;
});
ipcMain.handle('app:choosePlayer', (_event, playerId) => {
  const player = connection.players.find((entry) => entry.id === playerId);
  if (!player) return state;
  state.settings.playerId = player.id;
  state.settings.playerName = player.name;
  persistState();
  const local = connection.players.find((entry) => entry.id === state.settings.playerId);
  if (local) localTeamNum = local.teamNum;
  updateConnection({ message: 'Connecté — joueur reconnu' });
  return state;
});

app.whenReady().then(async () => {
  readState();
  createMainWindow();
  createOverlayWindow();
  if (state.settings.controllerOverlayVisible) createControllerOverlayWindow();
  configureStatsApiAutomatically();
  connectStatsSocket();
  if (state.session.active && (state.session.startMmr === null || state.session.startMmr === undefined)) {
    syncSessionMmrBaseline(state.session.startedAt);
  } else if (!state.session.active) {
    scheduleIdleMmrSync();
  }
  if (state.session.active && state.session.history.some((entry) => entry.trackerPending)) {
    scheduleTrackerSync(state.session.startedAt);
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
  checkForUpdate().catch((error) => console.warn('Vérification de mise à jour impossible :', error.message));
});

app.on('before-quit', () => {
  quitting = true;
  clearTimeout(reconnectTimer);
  clearTimeout(idleMmrTimer);
  if (statsSocket) statsSocket.close();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
