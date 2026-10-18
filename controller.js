const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const DEAD_ZONE = 0.035;

let lastStatusKey = '';

function cleanAxis(value) {
  const axis = Number(value) || 0;
  return Math.abs(axis) < DEAD_ZONE ? 0 : Math.max(-1, Math.min(1, axis));
}

function buttonValue(pad, index) {
  const button = pad.buttons?.[index];
  if (button === undefined || button === null) return 0;
  if (typeof button === 'number') return button;
  return Math.max(Number(button.value) || 0, button.pressed ? 1 : 0);
}

function controllerLabel(pad) {
  const label = String(pad.id || '').replace(/\s+/g, ' ').trim();
  if (/dualshock\s*4|playstation|sony/i.test(label) || /wireless controller.*054c/i.test(label)) return 'DualShock 4';
  return label ? label.slice(0, 52) : `Manette ${pad.index + 1}`;
}

function chooseGamepad() {
  if (typeof navigator.getGamepads !== 'function') return null;
  let pads;
  try {
    pads = [...navigator.getGamepads()].filter((pad) => pad?.connected);
  } catch {
    return null;
  }
  return pads.find((pad) => /dualshock\s*4|playstation|sony|wireless controller.*054c/i.test(pad.id || '')) || pads[0] || null;
}

function reportStatus(pad) {
  const next = pad ? { connected: true, name: controllerLabel(pad) } : { connected: false, name: '' };
  const key = `${next.connected}:${next.name}`;
  if (key === lastStatusKey) return;
  lastStatusKey = key;
  window.rally.reportControllerStatus(next);
}

function setStick(cap, rawX, rawY) {
  const x = cleanAxis(rawX);
  const y = cleanAxis(rawY);
  cap.setAttribute('transform', `translate(${x * 28} ${y * 28})`);
}

function updateTrigger(selector, value) {
  const trigger = $(selector);
  trigger.style.opacity = String(Math.max(0, Math.min(1, value * 0.72)));
  trigger.classList.toggle('active', value > 0.08);
}

function resetVisuals() {
  setStick($('#leftStickCap'), 0, 0);
  setStick($('#rightStickCap'), 0, 0);
  updateTrigger('[data-button="6"]', 0);
  updateTrigger('[data-button="7"]', 0);
  $$('[data-button]').forEach((element) => element.classList.remove('active'));
}

function renderGamepad(pad) {
  if (!pad) {
    resetVisuals();
    return;
  }

  setStick($('#leftStickCap'), pad.axes?.[0], pad.axes?.[1]);
  setStick($('#rightStickCap'), pad.axes?.[2], pad.axes?.[3]);
  updateTrigger('[data-button="6"]', buttonValue(pad, 6));
  updateTrigger('[data-button="7"]', buttonValue(pad, 7));

  $$('[data-button]').forEach((element) => {
    const index = Number(element.dataset.button);
    if (index === 6 || index === 7) return;
    element.classList.toggle('active', buttonValue(pad, index) > 0.45);
  });
}

function poll() {
  if (document.visibilityState === 'hidden') {
    setTimeout(poll, 500);
    return;
  }
  const pad = chooseGamepad();
  reportStatus(pad);
  renderGamepad(pad);
  requestAnimationFrame(poll);
}

function renderPlacement(state) {
  $('#controllerStage').classList.toggle('moving', Boolean(state?.settings?.controllerOverlayMovable));
}

window.addEventListener('gamepadconnected', () => renderGamepad(chooseGamepad()));
window.addEventListener('gamepaddisconnected', () => renderGamepad(chooseGamepad()));
window.rally.loadState().then(renderPlacement);
window.rally.onStateChanged(renderPlacement);
requestAnimationFrame(poll);
