const overlayCard = document.querySelector('#overlayCard');
const moveDone = document.querySelector('#overlayMoveDone');
const resizeHandle = document.querySelector('#overlayResizeHandle');

const LAYOUT_SIZES = {
  column: { width: 230, height: 234 },
  tiles: { width: 312, height: 164 },
  bar: { width: 520, height: 82 }
};
const MIN_SCALE = 40;
const MAX_SCALE = 160;
let appState = null;
let saveTimer;

function render(state) {
  appState = state;
  window.RallyOverlay.renderState(overlayCard, state);
}

// The preload bridge is absent when this page is opened outside Electron (for example a
// static style preview), so keep the markup renderable instead of throwing.
if (window.rally) {
  window.rally.loadState().then(render);
  window.rally.onStateChanged(render);
}

moveDone.addEventListener('click', () => {
  if (!window.rally) return;
  window.rally.setOverlayMovable(false).then(render);
});

resizeHandle.addEventListener('pointerdown', (event) => {
  if (!appState || !window.rally) return;
  event.preventDefault();
  resizeHandle.setPointerCapture(event.pointerId);
  const startX = event.clientX;
  const startScale = Number(appState.settings.overlayScale) || 100;
  const layout = Object.prototype.hasOwnProperty.call(LAYOUT_SIZES, appState.settings.overlayLayout) ? appState.settings.overlayLayout : 'column';
  const pixelsPerPercent = LAYOUT_SIZES[layout].width / 100;
  let lastScale = startScale;

  const onMove = (moveEvent) => {
    const next = Math.round(Math.min(MAX_SCALE, Math.max(MIN_SCALE, startScale + (moveEvent.clientX - startX) / pixelsPerPercent)));
    if (next === lastScale) return;
    lastScale = next;
    render({ ...appState, settings: { ...appState.settings, overlayScale: next } });
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => window.rally.saveState(appState).then(render), 120);
  };

  const onUp = () => {
    resizeHandle.removeEventListener('pointermove', onMove);
    resizeHandle.removeEventListener('pointerup', onUp);
    resizeHandle.removeEventListener('pointercancel', onUp);
    clearTimeout(saveTimer);
    window.rally.saveState(appState).then(render);
  };

  resizeHandle.addEventListener('pointermove', onMove);
  resizeHandle.addEventListener('pointerup', onUp);
  resizeHandle.addEventListener('pointercancel', onUp);
});
