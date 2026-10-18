(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.RallyRanks = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PLAYLIST_LABELS = { '10': '1V1', '11': '2V2', '13': '3V3' };
  const GROUPS = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Champion', 'Grand Champion'];
  const TIER_NAMES = ['Unranked'];
  for (const group of GROUPS) {
    TIER_NAMES.push(`${group} I`, `${group} II`, `${group} III`);
  }
  TIER_NAMES.push('Supersonic Legend');

  function finite(value) {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function tierNameForIndex(index) {
    const id = finite(index);
    return id === null ? '' : (TIER_NAMES[Math.round(id)] || '');
  }

  function tierIndexForName(name) {
    const normalized = String(name || '').trim().toLowerCase();
    if (!normalized) return null;
    const index = TIER_NAMES.findIndex((tier) => tier.toLowerCase() === normalized);
    return index >= 0 ? index : null;
  }

  function normalizeRank(rank) {
    if (!rank || typeof rank !== 'object') return null;
    const tier = rank.tier ?? rank.rank ?? rank.currentRank;
    const tierMetadata = tier && typeof tier === 'object' ? (tier.metadata || tier.meta || {}) : {};
    const division = rank.division ?? rank.currentDivision;
    const divisionMetadata = division && typeof division === 'object' ? (division.metadata || division.meta || {}) : {};
    const tierName = String(
      rank.tierName || rank.rankName || rank.currentRankName || rank.name || tierMetadata.name || tierMetadata.displayName ||
      (typeof tier === 'string' ? tier : '')
    ).trim();
    let tierIndex = finite(rank.tierIndex ?? rank.tier_index ?? rank.rankIndex ?? (tier && typeof tier === 'object' ? tier.value : tier));
    if (tierIndex === null) tierIndex = tierIndexForName(tierName);

    const divisionName = String(
      rank.divisionName || divisionMetadata.name || divisionMetadata.displayName ||
      (typeof division === 'string' ? division : '')
    ).trim();
    const divisionIndex = finite(rank.divisionIndex ?? rank.division_index ?? (division && typeof division === 'object' ? division.value : division));
    const deltaUp = finite(rank.deltaUp ?? rank.delta_up ?? divisionMetadata.deltaUp);
    const deltaDown = finite(rank.deltaDown ?? rank.delta_down ?? divisionMetadata.deltaDown);
    const mmr = finite(rank.mmr ?? rank.rating ?? rank.value);

    let pointsToNext = finite(rank.pointsToNext ?? rank.points_to_next ?? rank.deltaToNextRank);
    let approximate = Boolean(rank.approximate ?? rank.isApproximate);
    const nextTierName = tierIndex === null ? String(rank.nextTierName || rank.next_rank || '') : tierNameForIndex(tierIndex + 1);
    if (pointsToNext === null && tierIndex !== null && nextTierName && deltaUp !== null && divisionIndex !== null) {
      if (divisionIndex >= 3) {
        pointsToNext = Math.max(0, Math.round(deltaUp));
        approximate = false;
      } else if (deltaDown !== null) {
        const width = deltaUp + deltaDown;
        pointsToNext = Math.max(0, Math.round(deltaUp + (3 - divisionIndex) * width));
        approximate = true;
      }
    }

    const rankIndex = tierIndex === null ? tierIndexForName(tierName) : Math.round(tierIndex);
    let progressPercent = null;
    if (rankIndex === TIER_NAMES.length - 1) progressPercent = 100;
    else if (divisionIndex !== null && deltaUp !== null && deltaDown !== null && deltaUp + deltaDown > 0) {
      const withinDivision = Math.min(1, Math.max(0, deltaDown / (deltaUp + deltaDown)));
      progressPercent = Math.min(100, Math.max(0, ((Math.round(divisionIndex) + withinDivision) / 4) * 100));
    }
    return {
      mmr: mmr === null ? null : Math.round(mmr),
      tierName: tierName || tierNameForIndex(rankIndex),
      tierIndex: rankIndex,
      divisionName,
      divisionIndex: divisionIndex === null ? null : Math.round(divisionIndex),
      deltaUp,
      deltaDown,
      pointsToNext: pointsToNext === null ? null : Math.round(pointsToNext),
      approximate,
      nextTierName: nextTierName || '',
      nextTierIndex: rankIndex !== null && rankIndex < TIER_NAMES.length - 1 ? rankIndex + 1 : null,
      progressPercent
    };
  }

  function rankIconPath(index) {
    const id = finite(index);
    return id === null || id < 0 || id >= TIER_NAMES.length ? '' : `assets/ranks/rank-${Math.round(id)}.png`;
  }

  function pickMmr(state, playlistId) {
    const value = state?.settings?.mmrByPlaylist?.[playlistId];
    if (value !== null && value !== undefined && Number.isFinite(Number(value))) return Math.round(Number(value));
    const session = state?.session || {};
    if (String(session.playlistId || '') === playlistId && session.currentMmr !== null && session.currentMmr !== undefined && Number.isFinite(Number(session.currentMmr))) {
      return Math.round(Number(session.currentMmr));
    }
    return null;
  }

  function overlayView(state) {
    const settings = state?.settings || {};
    const session = state?.session || {};
    const playlistId = String(settings.overlayPlaylistId || '11');
    const rank = normalizeRank(settings.rankByPlaylist?.[playlistId]);
    const overlayScale = Number.isFinite(Number(settings.overlayScale))
      ? Math.min(160, Math.max(40, Math.round(Number(settings.overlayScale))))
      : 100;
    const overlayOpacity = Number.isFinite(Number(settings.overlayOpacity))
      ? Math.min(100, Math.max(20, Math.round(Number(settings.overlayOpacity))))
      : 65;
    const overlayLayout = ['column', 'tiles', 'bar', 'accent-bar'].includes(settings.overlayLayout) ? settings.overlayLayout : 'column';
    const overlayMovable = Boolean(settings.overlayMovable);
    const overlayStyle = ['glass', 'minimal', 'neon'].includes(settings.overlayStyle) ? settings.overlayStyle : 'glass';
    const sessionMatchesMode = Boolean(session.active) && String(session.playlistId || '') === playlistId;
    const startMmr = finite(session.startMmr);
    const currentSessionMmr = finite(session.currentMmr);
    const sessionDelta = sessionMatchesMode && startMmr !== null && currentSessionMmr !== null
      ? Math.round(currentSessionMmr - startMmr)
      : null;
    const sessionGoalMmr = [25, 50, 100].includes(Number(settings.sessionGoalMmr)) ? Number(settings.sessionGoalMmr) : 50;
    const nextTierIndex = rank?.nextTierIndex ?? null;
    return {
      playlistId,
      playlistLabel: PLAYLIST_LABELS[playlistId] || '2V2',
      overlayScale,
      overlayOpacity,
      overlayLayout,
      overlayMovable,
      overlayStyle,
      overlayCorner: ['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(settings.overlayCorner) ? settings.overlayCorner : 'top-right',
      overlayOffsetX: Number.isFinite(Number(settings.overlayOffsetX)) ? Math.min(250, Math.max(-250, Number(settings.overlayOffsetX))) : 0,
      overlayOffsetY: Number.isFinite(Number(settings.overlayOffsetY)) ? Math.min(250, Math.max(-250, Number(settings.overlayOffsetY))) : 0,
      mmr: pickMmr(state, playlistId),
      rankName: rank?.tierName || '',
      rankIcon: rankIconPath(rank?.tierIndex),
      rankIndex: rank?.tierIndex ?? null,
      nextRankName: rank?.nextTierName || '',
      nextRankIcon: rankIconPath(nextTierIndex),
      pointsToNext: rank?.pointsToNext ?? null,
      approximate: Boolean(rank?.approximate),
      progressPercent: rank?.progressPercent ?? null,
      isTopRank: Boolean(rank?.tierName === 'Supersonic Legend' || (rank?.tierIndex === TIER_NAMES.length - 1)),
      sessionMatchesMode,
      sessionDelta,
      sessionGoalMmr,
      sessionGoalReached: sessionDelta !== null && sessionDelta >= sessionGoalMmr,
      wins: sessionMatchesMode ? Math.max(0, Math.round(Number(session.wins) || 0)) : 0,
      losses: sessionMatchesMode ? Math.max(0, Math.round(Number(session.losses) || 0)) : 0,
      streakType: sessionMatchesMode ? (session.streakType === 'win' || session.streakType === 'loss' ? session.streakType : '') : '',
      streakCount: sessionMatchesMode ? Math.max(0, Math.round(Number(session.streakCount) || 0)) : 0
    };
  }

  function render(rootElement, view) {
    if (!rootElement || !view) return;
    const layoutSizes = { column: { width: 230, height: 234 }, tiles: { width: 312, height: 164 }, bar: { width: 520, height: 82 }, 'accent-bar': { width: 760, height: 102 } };
    const layoutSize = layoutSizes[view.overlayLayout] || layoutSizes.column;
    rootElement.dataset.style = view.overlayStyle;
    rootElement.dataset.corner = view.overlayCorner;
    rootElement.dataset.layout = view.overlayLayout;
    rootElement.style.setProperty('--overlay-scale', String(view.overlayScale / 100));
    rootElement.style.setProperty('--overlay-opacity', String(view.overlayOpacity / 100));
    rootElement.style.setProperty('--layout-width', `${layoutSize.width}px`);
    rootElement.style.setProperty('--layout-height', `${layoutSize.height}px`);
    rootElement.style.setProperty('--preview-offset-x', `${view.overlayOffsetX * 0.78}px`);
    rootElement.style.setProperty('--preview-offset-y', `${view.overlayOffsetY * 0.78}px`);
    if (typeof document !== 'undefined' && document.body?.classList.contains('overlay-window')) {
      document.body.style.setProperty('--overlay-scale', String(view.overlayScale / 100));
      document.body.style.setProperty('--overlay-opacity', String(view.overlayOpacity / 100));
      document.body.style.setProperty('--layout-width', `${layoutSize.width}px`);
      document.body.style.setProperty('--layout-height', `${layoutSize.height}px`);
      document.body.classList.toggle('moving', view.overlayMovable);
    }
    const screenPreview = rootElement.closest('.screen-preview');
    if (screenPreview) screenPreview.dataset.corner = view.overlayCorner;
    const setText = (field, value) => {
      const node = rootElement.querySelector(`[data-field="${field}"]`);
      if (node) node.textContent = value;
    };
    const setIcon = (field, src, alt) => {
      const node = rootElement.querySelector(`[data-field="${field}"]`);
      if (!node) return;
      node.hidden = !src;
      if (src) node.src = src;
      node.alt = alt || '';
    };

    setText('playlist', view.playlistLabel);
    setText('mmr', view.mmr === null ? '—' : String(view.mmr));
    setText('rank', view.rankName || (view.mmr === null ? 'En attente du MMR' : 'Rang en attente'));
    setText('wins', String(view.wins));
    setText('losses', String(view.losses));
    setText('streak', view.streakCount ? `${view.streakType === 'loss' ? '−' : '+'}${view.streakCount}` : '0');
    setIcon('rank-icon', view.rankIcon, view.rankName);

    const nextLine = rootElement.querySelector('[data-field="next-line"]');
    const nextIcon = rootElement.querySelector('[data-field="next-icon"]');
    const nextRank = rootElement.querySelector('[data-field="next-rank"]');
    if (view.isTopRank && view.rankName) {
      if (nextLine) nextLine.hidden = false;
      if (nextIcon) nextIcon.hidden = true;
      if (nextRank) nextRank.textContent = 'Rang maximum';
      setText('next-distance', '');
    } else if (view.nextRankName && view.pointsToNext !== null && view.pointsToNext !== undefined) {
      if (nextLine) nextLine.hidden = false;
      if (nextIcon) {
        nextIcon.src = view.nextRankIcon;
        nextIcon.alt = view.nextRankName;
        nextIcon.hidden = !view.nextRankIcon;
      }
      if (nextRank) nextRank.textContent = `${view.approximate ? '~' : ''}${view.pointsToNext} MMR · ${view.nextRankName}`;
      setText('next-distance', `Plus que ${view.approximate ? '~' : ''}${view.pointsToNext} MMR pour`);
    } else {
      if (nextLine) nextLine.hidden = true;
      if (nextRank) nextRank.textContent = '';
    }
    const progress = rootElement.querySelector('.rank-progress span');
    if (progress) progress.style.width = `${view.progressPercent === null || view.progressPercent === undefined ? 0 : view.progressPercent}%`;
    const progressTrack = rootElement.querySelector('.rank-progress');
    if (progressTrack) progressTrack.hidden = view.progressPercent === null || view.progressPercent === undefined;

    const sessionLine = rootElement.querySelector('[data-field="session-line"]');
    if (sessionLine) sessionLine.hidden = !view.sessionMatchesMode;
    setText('session-delta', view.sessionDelta === null ? '—' : `${view.sessionDelta > 0 ? '+' : view.sessionDelta < 0 ? '−' : ''}${Math.abs(view.sessionDelta)}`);
    setText('record', `${view.wins}V · ${view.losses}D`);
    const delta = rootElement.querySelector('[data-field="session-delta"]');
    if (delta) {
      delta.classList.toggle('goal-reached', view.sessionGoalReached);
      delta.classList.toggle('negative', view.sessionDelta !== null && view.sessionDelta < 0);
    }
  }

  return { PLAYLIST_LABELS, TIER_NAMES, normalizeRank, tierNameForIndex, overlayView, render };
});
