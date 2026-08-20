const CONNECTED_STATE = 'connected'
const HIDDEN_CLASS = 'hidden'
const TAP_FLASH_ACTIVE_CLASS = 'active'
const TAP_FLASH_DURATION_MS = 400
const QR_SIZE_PX = 220

export function createHud() {
  const statusElement = document.querySelector('[data-status]')
  const statusDetailElement = document.querySelector('[data-status-detail]')
  const latencyElement = document.querySelector('[data-latency]')
  const tapsElement = document.querySelector('[data-taps]')
  const pairingPanel = document.getElementById('pairing')
  const qrElement = document.getElementById('qr')
  const linkElement = document.querySelector('[data-link]')
  const tapFlashElement = document.getElementById('tap-flash')

  let renderedPeerId = null
  let tapFlashTimer = null

  function setState(state, detail) {
    statusElement.textContent = state
    statusElement.dataset.state = state
    statusDetailElement.textContent = detail == null ? '' : detail
    pairingPanel.classList.toggle(HIDDEN_CLASS, state === CONNECTED_STATE)
  }

  function setPairing(peerId, phoneLink) {
    linkElement.textContent = phoneLink
    if (peerId === renderedPeerId) {
      return
    }
    renderedPeerId = peerId
    qrElement.innerHTML = ''
    if (typeof QRCode === 'undefined') {
      return
    }
    new QRCode(qrElement, {
      text: phoneLink,
      width: QR_SIZE_PX,
      height: QR_SIZE_PX,
      correctLevel: QRCode.CorrectLevel.M,
    })
  }

  function setLatency(rttMs) {
    latencyElement.textContent = `${Math.round(rttMs)} ms`
  }

  function flashTap(tapCount) {
    tapsElement.textContent = String(tapCount)
    tapFlashElement.classList.remove(TAP_FLASH_ACTIVE_CLASS)
    void tapFlashElement.offsetWidth
    tapFlashElement.classList.add(TAP_FLASH_ACTIVE_CLASS)
    if (tapFlashTimer !== null) {
      clearTimeout(tapFlashTimer)
    }
    tapFlashTimer = setTimeout(() => {
      tapFlashTimer = null
      tapFlashElement.classList.remove(TAP_FLASH_ACTIVE_CLASS)
    }, TAP_FLASH_DURATION_MS)
  }

  return { setState, setPairing, setLatency, flashTap }
}
