import { PROTOCOL_VERSION } from '../shared/protocol.js'
import { peerOptionsFromSearch } from '../shared/peer-config.js'
import { buildScene } from './scene.js'
import { createHud } from './hud.js'
import { createDesktopPairing } from './pairing.js'

console.log(`throw-a-ball desktop M1 booting, protocol v${PROTOCOL_VERSION}`)

const { scene, camera, renderer, ball } = buildScene()
document.body.appendChild(renderer.domElement)

function handleResize() {
  camera.aspect = window.innerWidth / window.innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(window.innerWidth, window.innerHeight)
}
window.addEventListener('resize', handleResize)

function render() {
  requestAnimationFrame(render)
  renderer.render(scene, camera)
}
render()

const pairingStatus = {
  state: null,
  detail: null,
  peerId: null,
  phoneLink: null,
  latencyMs: null,
  tapCount: 0,
}

window.__throwABall = { scene, camera, renderer, ball, pairing: pairingStatus }

const hud = createHud()

const pairing = createDesktopPairing({
  peerOptions: peerOptionsFromSearch(location.search),
  callbacks: {
    onStateChange(state, detail) {
      pairingStatus.state = state
      pairingStatus.detail = detail
      hud.setState(state, detail)
    },
    onPeerId(peerId, phoneLink) {
      pairingStatus.peerId = peerId
      pairingStatus.phoneLink = phoneLink
      hud.setPairing(peerId, phoneLink)
    },
    onLatency(rttMs) {
      pairingStatus.latencyMs = rttMs
      hud.setLatency(rttMs)
    },
    onTap() {
      pairingStatus.tapCount += 1
      hud.flashTap(pairingStatus.tapCount)
    },
  },
})

pairing.start()
