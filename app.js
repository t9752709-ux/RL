let appState;
let gameConnection = { connected: false, players: [], gameActive: false, message: 'En attente du jeu' };
let controllerStatus = { connected: false, name: '' };
let toastTimer;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const num = (value, fallback = 0) => Number.isFinite(Number(value)) ? Math.round(Number(value)) : fallback;
const signed = (value) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value)}`;
const PLAYLIST_LABELS = { '10': '1v1', '11': '2v2', '13': '3v3' };
const OVERLAY_SIZES = {
  'accent-bar': { width: 760, height: 102 },
  'accent-grid': { width: 450, height: 190 },
  'accent-stack': { width: 270, height: 370 },
  'accent-slim': { width: 900, height: 72 }
};

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2700);
}

function relativeTime(isoDate) {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function sessionDelta() {
  const session = appState.session;
  if (!session.active || session.startMmr === null || session.currentMmr === null) return null;
  return num(session.currentMmr) - num(session.startMmr);
}

function render() {
  if (!appState) return;
  const { session, settings } = appState;
  const delta = sessionDelta();
  const active = Boolean(session.active);
  const overlayPlaylistId = String(settings.overlayPlaylistId || '11');
  const overlayLayout = ['accent-bar', 'accent-grid', 'accent-stack', 'accent-slim'].includes(settings.overlayLayout) ? settings.overlayLayout : 'accent-bar';
  const sessionTag = $('#sessionTag');
  sessionTag.classList.toggle('active', active);
  sessionTag.querySelector('span:last-child').textContent = active ? 'Session en cours' : 'Session inactive';
  $('#mmrDelta').textContent = delta === null ? '—' : signed(delta);
  $('#mmrDelta').className = delta !== null && delta < 0 ? 'negative' : '';
  const played = session.wins + session.losses;
  const sessionGoal = [25, 50, 100].includes(num(settings.sessionGoalMmr, 50)) ? num(settings.sessionGoalMmr, 50) : 50;
  const goalReached = delta !== null && delta >= sessionGoal;
  $('#mmrCaption').textContent = delta === null
    ? (active ? 'MMR de départ en attente' : 'Lance une session pour commencer')
    : goalReached
      ? `Objectif +${sessionGoal} MMR atteint !`
      : `${played} match${played > 1 ? 's' : ''} · objectif +${sessionGoal} MMR`;
  $('#startMmrLabel').textContent = session.startMmr === null ? '—' : num(session.startMmr);
  $('#currentMmrLabel').textContent = session.currentMmr === null ? '—' : num(session.currentMmr);
  $('#winsCount').textContent = num(session.wins);
  $('#lossesCount').textContent = num(session.losses);
  $('#winrate').textContent = played ? `${Math.round((session.wins / played) * 100)} % de victoires` : '0 % des matchs';
  $('#lossrate').textContent = played ? `${Math.round((session.losses / played) * 100)} % des matchs` : '0 % des matchs';
  $('#streakCount').textContent = session.streakCount ? `${session.streakType === 'loss' ? '−' : '+'}${session.streakCount}` : '—';
  $('#streakName').textContent = session.streakType === 'win' ? 'Série de victoires' : session.streakType === 'loss' ? 'Série de défaites' : 'Aucune série';
  $('#streakCaption').textContent = `${session.streakCount || 0} match${session.streakCount === 1 ? '' : 's'} consécutif${session.streakCount === 1 ? '' : 's'}`;
  const recentResults = session.history.slice(0, 5);
  $('#recentForm').innerHTML = recentResults.length
    ? recentResults.map((match) => `<span class="form-result ${match.result === 'win' ? 'win' : 'loss'}" title="${match.result === 'win' ? 'Victoire' : 'Défaite'}">${match.result === 'win' ? 'V' : 'D'}</span>`).join('')
    : '<span class="recent-form-empty">Aucun match</span>';
  const fill = delta === null ? 0 : Math.min(100, Math.max(0, (delta / sessionGoal) * 100));
  $('#mmrTrackFill').style.width = `${fill}%`;
  $('.mmr-card').classList.toggle('goal-reached', goalReached);
  $('#sessionGoalSelect').value = String(sessionGoal);

  $('#currentMmrInput').value = session.currentMmr === null ? '' : num(session.currentMmr);
  const trackerMode = settings.mmrMode === 'tracker';
  $('#mmrForm').hidden = true;
  $('#currentMmrInput').disabled = true;
  $('#updateMmrButton').disabled = true;
  $('#trackerStatus').hidden = !trackerMode;
  $('#trackerStatus').textContent = gameConnection.trackerMessage || 'MMR Tracker non synchronisé';
  $('#trackerSyncButton').hidden = true;
  $('#trackerOpenButton').hidden = true;
  $('#playlistSelect').value = overlayPlaylistId;
  $('#playlistSelect').disabled = false;
  $('#playlistSelect').hidden = false;
  $('.playlist-label').hidden = false;
  $('#sessionAction').hidden = active;
  $('#endSessionButton').hidden = !active;
  $('#resetSessionStatsButton').hidden = !active;
  $('#copySessionSummaryButton').hidden = !played;
  $('.result-buttons').hidden = !active;
  $('#sessionAction').textContent = 'Démarrer une session';
  $('#winButtonMmr').textContent = settings.mmrMode === 'estimate' ? `+${num(settings.winMmr, 9)} MMR estimé` : 'Résultat auto';
  $('#lossButtonMmr').textContent = settings.mmrMode === 'estimate' ? `−${num(settings.lossMmr, 9)} MMR estimé` : 'Résultat auto';
  $('#matchHint').textContent = !gameConnection.connected
    ? 'Ouvre Rocket League pour activer le suivi.'
    : !settings.playerId
      ? 'Compte en cours de détection.'
      : gameConnection.gameActive
        ? 'Résultat détecté à la fin du match.'
        : 'Suivi prêt.';
  $('#recentCount').textContent = `${session.history.length} match${session.history.length === 1 ? '' : 's'}`;
  renderHistory(session.history);

  renderOverlayPreview(appState);

  $('#overlayToggle').checked = Boolean(settings.overlayVisible);
  $('#overlaySwitchLabel').textContent = settings.overlayVisible ? 'Overlay activé' : 'Overlay désactivé';
  $('#sessionGoalSelect').value = String(sessionGoal);
  const overlayScale = Math.min(160, Math.max(40, num(settings.overlayScale, 100)));
  $('#overlayScaleInput').value = String(overlayScale);
  $('#overlayScaleValue').textContent = `${overlayScale} %`;
  $('#overlayLayoutSelect').value = overlayLayout;
  $('#overlayMoveButton').textContent = settings.overlayMovable ? 'Terminer le placement' : 'Déplacer / redimensionner';
  $$('.corner-picker button').forEach((button) => button.classList.toggle('selected', button.dataset.corner === settings.overlayCorner));
  const controllerVisible = Boolean(settings.controllerOverlayVisible);
  const controllerScale = Math.min(100, Math.max(35, num(settings.controllerOverlayScale, 100)));
  $('#controllerOverlayToggle').checked = controllerVisible;
  $('#controllerStatus').textContent = controllerStatus.connected
    ? `Manette connectée : ${controllerStatus.name}.`
    : controllerVisible
      ? 'Overlay actif · manette non détectée.'
      : 'Manette non détectée. Connecte-la puis active l’affichage.';
  $('#controllerScaleInput').value = String(controllerScale);
  $('#controllerScaleValue').textContent = `${controllerScale} %`;
  $('#controllerMoveButton').disabled = !controllerVisible;
  $('#controllerMoveButton').textContent = settings.controllerOverlayMovable ? 'Terminer le placement' : 'Déplacer la manette';
  renderConnection();
}

function renderOverlayPreview(state = appState) {
  if (!state) return;
  window.RallyOverlay.renderState($('#previewWidget'), state);
  const scale = Math.min(160, Math.max(40, num(state.settings.overlayScale, 100))) / 100;
  const layout = ['accent-bar', 'accent-grid', 'accent-stack', 'accent-slim'].includes(state.settings.overlayLayout) ? state.settings.overlayLayout : 'accent-bar';
  const size = OVERLAY_SIZES[layout];
  $('#overlayDimensions').textContent = `${Math.round(size.width * scale)} × ${Math.round(size.height * scale)} px`;
}

function renderHistory(history) {
  const list = $('#historyList');
  if (!history.length) {
    list.innerHTML = '<div class="empty-history"><span>◌</span><div><b>Pas encore de match</b><small>Les résultats apparaîtront ici.</small></div></div>';
    return;
  }
  list.innerHTML = history.slice(0, 4).map((match) => {
    const isWin = match.result === 'win';
    const delta = match.mmrChange === null || match.mmrChange === undefined ? null : num(match.mmrChange);
    const deltaText = delta === null ? (match.trackerPending ? '…' : '—') : signed(delta);
    const mmrCaption = match.trackerPending
      ? 'En attente de mise à jour Tracker'
      : match.trackerUnavailable
        ? 'Premier relevé reçu · delta indisponible'
      : match.mmrEstimateMethod === 'unchanged-snapshot'
        ? match.mmrCoveredMatches > 1
          ? `MMR total inchangé · répartition estimée sur ${match.mmrCoveredMatches} matchs`
          : 'Aucun changement détecté après 15 min · estimation à 0'
      : match.mmrCoveredMatches > 1
        ? `Répartition estimée sur ${match.mmrCoveredMatches} matchs · total Tracker synchronisé`
      : match.mmrEstimated
        ? 'Variation estimée · total Tracker synchronisé'
        : `MMR après match : ${num(match.mmr)}`;
    return `<div class="history-row"><span class="history-result ${isWin ? 'win' : 'loss'}">${isWin ? '↗' : '↘'}</span><span class="history-description"><b>${isWin ? 'Victoire' : 'Défaite'}</b><small>${mmrCaption}</small></span><span class="history-delta ${delta > 0 ? 'positive' : delta < 0 ? 'negative' : ''}">${deltaText}</span><time class="history-time">${relativeTime(match.at)}</time></div>`;
  }).join('');
}

function renderConnection() {
  const pill = $('#connectionPill');
  const dot = pill.querySelector('.status-dot');
  dot.classList.toggle('online', gameConnection.connected);
  pill.classList.toggle('connected', gameConnection.connected);
  pill.querySelector('span').textContent = gameConnection.connected ? (appState.settings.playerName || 'Jeu connecté') : 'Jeu déconnecté';
  $('#sidebarConnection').textContent = gameConnection.connected ? (appState.settings.playerName || 'Rocket League connecté') : 'En attente du jeu';
  $('#sidebarDot').classList.toggle('online', gameConnection.connected);
  $('#settingsStatusDot').classList.toggle('online', gameConnection.connected);
  $('#settingsGameState').textContent = gameConnection.connected ? 'Connecté' : 'En attente du jeu';
  $('#settingsPlayerName').textContent = appState.settings.playerName || (gameConnection.connected ? 'Compte en cours de détection' : 'Recherche automatique');
  const configured = Boolean(appState.settings.installPath);
  const state = $('#setupState');
  state.classList.toggle('configured', configured);
  state.querySelector('span:last-child').textContent = gameConnection.setupMessage || (configured ? 'Configurée automatiquement' : 'Configuration automatique en attente');
  $('#setupButton').hidden = true;
  $('#playersPanel').hidden = true;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

async function saveSettings(patch) {
  appState.settings = { ...appState.settings, ...patch };
  appState = await window.rally.saveState(appState);
  render();
}

function showPage(pageName) {
  const pages = {
    session: { title: 'Accueil', eyebrow: 'SESSION' },
    matches: { title: 'Historique', eyebrow: 'RÉSULTATS DE SESSION' },
    overlay: { title: 'Overlay', eyebrow: 'PERSONNALISE TON AFFICHAGE' },
    settings: { title: 'Réglages', eyebrow: 'CONNEXION AU JEU' }
  };
  if (!pages[pageName]) pageName = 'session';
  $('#sessionPage').hidden = pageName !== 'session';
  $('#matchesPage').hidden = pageName !== 'matches';
  $('#overlayPage').hidden = pageName !== 'overlay';
  $('#settingsPage').hidden = pageName !== 'settings';
  $('#pageTitle').textContent = pages[pageName].title;
  $('#headerEyebrow').textContent = pages[pageName].eyebrow;
  $$('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.page === pageName));
}

async function configureGame() {
  try {
    const folder = await window.rally.chooseGameFolder();
    if (!folder) return;
    const result = await window.rally.enableStatsApi(folder);
    appState.settings.installPath = folder;
    render();
    showToast('Configuration enregistrée. Relance Rocket League pour la connexion.');
    const templateInfo = result.installFiles?.length ? ` Modèle : ${result.installFiles.map((file) => file.split(/[\\/]/).pop()).join(', ')}.` : '';
    const warning = result.warning ? ` ${result.warning}` : '';
    $('#setupState').querySelector('span:last-child').textContent = `Fichier utilisateur configuré.${templateInfo}${warning}`;
  } catch (error) {
    showToast(error.message || 'Impossible de configurer Rocket League.');
  }
}

function wireEvents() {
  $('#windowMinimize').addEventListener('click', () => window.rally.minimizeWindow());
  $('#windowMaximize').addEventListener('click', async () => {
    const maximized = await window.rally.toggleMaximizeWindow();
    $('#windowMaximize').textContent = maximized ? '❐' : '□';
  });
  $('#windowClose').addEventListener('click', () => window.rally.closeWindow());
  $('.window-titlebar').addEventListener('dblclick', async (event) => {
    if (event.target.closest('.window-controls')) return;
    const maximized = await window.rally.toggleMaximizeWindow();
    $('#windowMaximize').textContent = maximized ? '❐' : '□';
  });
  $$('.nav-item').forEach((button) => button.addEventListener('click', () => showPage(button.dataset.page)));
  $$('[data-page-link]').forEach((button) => button.addEventListener('click', () => showPage(button.dataset.pageLink)));
  $('#setupButton').addEventListener('click', configureGame);
  $('#sessionAction').addEventListener('click', async () => {
    try {
      if (appState.session.active) {
        const mmr = appState.session.currentMmr;
        appState = await window.rally.startSession(mmr ?? 0);
        showToast('Nouvelle session démarrée.');
      } else if (appState.settings.mmrMode === 'tracker') {
        appState = await window.rally.startSession(null);
        showToast(`Session démarrée à ${appState.session.startMmr} MMR.`);
      } else {
        const mmrValue = $('#currentMmrInput').value;
        if (mmrValue === '') {
          showToast('Saisis ton MMR actuel avant de démarrer.');
          $('#currentMmrInput').focus();
          return;
        }
        appState = await window.rally.startSession(mmrValue);
        showToast('Session démarrée.');
      }
      render();
    } catch (error) {
      showToast(error.message || 'Impossible de démarrer la session.');
    }
  });
  $('#endSessionButton').addEventListener('click', async () => {
    appState = await window.rally.resetSession();
    render();
    showToast('Session terminée.');
  });
  $('#resetSessionStatsButton').addEventListener('click', async () => {
    if (!appState.session.active || !window.confirm('Remettre victoires, défaites, série et historique à zéro ? La session restera active.')) return;
    try {
      appState = await window.rally.clearSessionStats();
      render();
      showToast('Stats remises à zéro.');
    } catch (error) {
      showToast(error.message || 'Impossible de réinitialiser les stats.');
    }
  });
  $('#copySessionSummaryButton').addEventListener('click', async () => {
    const session = appState.session;
    const playlist = PLAYLIST_LABELS[String(session.playlistId || appState.settings.playlistId || '11')] || 'Rocket League';
    const played = num(session.wins) + num(session.losses);
    const winrate = played ? Math.round((num(session.wins) / played) * 100) : 0;
    const delta = sessionDelta();
    const streak = session.streakCount ? ` · série ${signed(session.streakType === 'loss' ? -session.streakCount : session.streakCount)}` : '';
    const mmr = delta === null ? '' : ` · ${signed(delta)} MMR`;
    const summary = `Overlay RL · ${playlist} : ${num(session.wins)}V-${num(session.losses)}D (${winrate} %${mmr}${streak})`;
    try {
      await window.rally.copyText(summary);
      showToast('Bilan copié.');
    } catch (error) {
      showToast(error.message || 'Impossible de copier le bilan.');
    }
  });
  $('#mmrForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!appState.session.active) return;
    const value = num($('#currentMmrInput').value, appState.session.currentMmr || 0);
    appState.session.currentMmr = value;
    appState = await window.rally.saveState(appState);
    render();
    showToast('MMR actuel mis à jour.');
  });
  $('#manualWin').addEventListener('click', () => recordManual('win'));
  $('#manualLoss').addEventListener('click', () => recordManual('loss'));
  $('#trackerOpenButton').addEventListener('click', () => window.rally.openTracker());
  $('#settingsTrackerButton').addEventListener('click', () => window.rally.openTracker());
  $('#trackerSyncButton').addEventListener('click', async () => {
    try {
      const result = await window.rally.fetchTrackerMmr();
      if (!appState.session.active) $('#currentMmrInput').value = result.mmr;
      showToast(`MMR synchronisé : ${result.mmr}.`);
    } catch (error) {
      showToast(error.message || 'Impossible de synchroniser le MMR.');
    }
  });
  $('#refreshOverlayMmrButton').addEventListener('click', () => syncOverlayMmr(true));
  $('#overlayLayoutSelect').addEventListener('change', (event) => saveSettings({ overlayLayout: event.target.value, overlayBounds: null }));
  $('#overlayMoveButton').addEventListener('click', async () => {
    try {
      appState = await window.rally.setOverlayMovable(!appState.settings.overlayMovable);
      render();
      showToast(appState.settings.overlayMovable
        ? 'Glisse l’overlay et sa poignée, puis clique à nouveau pour enregistrer.'
        : 'Placement de l’overlay enregistré.');
    } catch (error) {
      showToast(error.message || 'Impossible de déplacer l’overlay.');
    }
  });
  $('#overlayScaleInput').addEventListener('input', (event) => {
    const scale = Number(event.target.value);
    $('#overlayScaleValue').textContent = `${scale} %`;
    renderOverlayPreview({ ...appState, settings: { ...appState.settings, overlayScale: scale } });
  });
  $('#overlayScaleInput').addEventListener('change', (event) => saveSettings({ overlayScale: Number(event.target.value) }));
  $('#overlayToggle').addEventListener('change', async (event) => {
    appState.settings.overlayVisible = event.target.checked;
    appState = await window.rally.saveState(appState);
    await window.rally.setOverlayVisible(event.target.checked);
    render();
  });
  $('#controllerOverlayToggle').addEventListener('change', async (event) => {
    try {
      appState = await window.rally.setControllerOverlayVisible(event.target.checked);
      render();
      showToast(event.target.checked ? 'Overlay de manette activé.' : 'Overlay de manette désactivé.');
    } catch (error) {
      render();
      showToast(error.message || 'Impossible de modifier l’overlay de manette.');
    }
  });
  $('#controllerScaleInput').addEventListener('input', (event) => {
    $('#controllerScaleValue').textContent = `${Number(event.target.value)} %`;
  });
  $('#controllerScaleInput').addEventListener('change', async (event) => {
    try {
      appState = await window.rally.setControllerOverlayScale(Number(event.target.value));
      render();
    } catch (error) {
      render();
      showToast(error.message || 'Impossible de modifier la taille de la manette.');
    }
  });
  $('#controllerMoveButton').addEventListener('click', async () => {
    try {
      appState = await window.rally.setControllerOverlayMovable(!appState.settings.controllerOverlayMovable);
      render();
      showToast(appState.settings.controllerOverlayMovable
        ? 'Glisse la manette à l’endroit voulu, puis termine le placement.'
        : 'Position de la manette enregistrée.');
    } catch (error) {
      showToast(error.message || 'Impossible de déplacer la manette.');
    }
  });
  $$('.corner-picker button').forEach((button) => button.addEventListener('click', async () => {
    appState.settings.overlayCorner = button.dataset.corner;
    appState = await window.rally.saveState(appState);
    await window.rally.setOverlayCorner(button.dataset.corner);
    render();
  }));
  $('#sessionGoalSelect').addEventListener('change', (event) => saveSettings({ sessionGoalMmr: Number(event.target.value) }));
  $('#playlistSelect').addEventListener('change', async (event) => {
    const playlistId = event.target.value;
    await saveSettings({ overlayPlaylistId: playlistId });
    await syncOverlayMmr(true);
  });
  $('#playersList').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-player-id]');
    if (!button) return;
    appState = await window.rally.choosePlayer(button.dataset.playerId);
    render();
    showToast(`Joueur reconnu : ${appState.settings.playerName}`);
  });
  window.rally.onStateChanged((next) => { appState = next; render(); });
  window.rally.onConnectionChanged((next) => { gameConnection = next; render(); });
  window.rally.onControllerStatus((next) => { controllerStatus = next; render(); });
}

async function recordManual(result) {
  appState = await window.rally.recordResult(result);
  render();
  showToast(result === 'win' ? 'Victoire ajoutée.' : 'Défaite ajoutée.');
}

async function syncOverlayMmr(showMessage = false) {
  if (!appState?.settings?.playerId) {
    if (showMessage) showToast('Overlay RL cherche encore ton compte Rocket League.');
    return;
  }
  const playlistId = String(appState.settings.overlayPlaylistId || '11');
  try {
    const result = await window.rally.fetchTrackerMmr(playlistId);
    if (showMessage) showToast(`MMR ${PLAYLIST_LABELS[playlistId]} synchronisé : ${result.mmr}.`);
  } catch (error) {
    if (showMessage) showToast(error.message || 'Impossible de synchroniser ce MMR.');
  }
}

async function initialize() {
  appState = await window.rally.loadState();
  $('#appVersion').textContent = await window.rally.getAppVersion();
  controllerStatus = await window.rally.getControllerStatus();
  wireEvents();
  // Subscribe before reading the initial connection state so a fast WebSocket
  // connection cannot be missed while the renderer is still initializing.
  gameConnection = await window.rally.getConnection();
  render();
  syncOverlayMmr(false);
}

initialize();
