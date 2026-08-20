import { PROTOCOL_VERSION } from '../shared/protocol.js'
import { buildScene } from './scene.js'

console.log(`throw-a-ball desktop M0 booting, protocol v${PROTOCOL_VERSION}`)

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

window.__throwABall = { scene, camera, renderer, ball }
