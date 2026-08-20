import { PROTOCOL_VERSION } from '../../shared/protocol.js';
import { peerOptionsFromSearch } from '../../shared/peer-config.js';
import { createPhoneConnection } from './connection.js';

const NO_PEER_PARAM_DETAIL = 'open this link from the QR code on the desktop page';
const PRESS_FEEDBACK_MS = 160;

const statusElement = document.querySelector('[data-status]');
const detailElement = document.querySelector('[data-status-detail]');
const tapCountElement = document.querySelector('[data-phone-taps]');
const tapZone = document.getElementById('tap-zone');
const footer = document.getElementById('footer');

const phone = { state: 'waiting', detail: '', tapCount: 0 };
window.__phone = phone;

footer.textContent = `protocol v${PROTOCOL_VERSION}`;

function renderState(state, detail) {
  phone.state = state;
  phone.detail = detail;
  statusElement.textContent = state;
  statusElement.dataset.state = state;
  detailElement.textContent = detail;
  tapZone.disabled = state !== 'connected';
}

function renderTapCount(count) {
  phone.tapCount = count;
  tapCountElement.textContent = String(count);
}

function flashPress() {
  tapZone.classList.add('pressed');
  setTimeout(() => tapZone.classList.remove('pressed'), PRESS_FEEDBACK_MS);
}

renderTapCount(0);

const desktopPeerId = new URLSearchParams(location.search).get('peer');

if (desktopPeerId === null) {
  renderState('waiting', NO_PEER_PARAM_DETAIL);
} else {
  const connection = createPhoneConnection({
    desktopPeerId,
    peerOptions: peerOptionsFromSearch(location.search),
    callbacks: { onStateChange: renderState, onTapSent: renderTapCount }
  });

  tapZone.addEventListener('pointerdown', () => {
    flashPress();
    connection.sendTap();
  });

  connection.start();
}
