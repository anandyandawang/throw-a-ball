import * as THREE from 'three'

const SKY_COLOR = 0x87ceeb
const GROUND_COLOR = 0x6b8f4e
const TARGET_CENTER = new THREE.Vector3(0, 1.2, -18.44)
const CAMERA_POSITION = new THREE.Vector3(0, 1.7, 0)
const BALL_RADIUS = 0.037

const SHOULDER_POSITION = new THREE.Vector3(0.34, 1.5, -0.95)
const ARM_LENGTH = 0.3
const FOREARM_TOP_RADIUS = 0.036
const FOREARM_TIP_RADIUS = 0.028
const HAND_RADIUS = 0.045
const BALL_HOLD_OFFSET = new THREE.Vector3(0, -0.34, 0)
const SKIN_COLOR = 0xd8a07a

const RING_COLORS = [0xffffff, 0x1a1a1a, 0x2f6fd6, 0xd6291a, 0xf4c430]
const RING_COUNT = RING_COLORS.length
const TARGET_OUTER_RADIUS = 0.6
const RING_Z_STEP = 0.001

function buildRenderer() {
  const renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(window.innerWidth, window.innerHeight)
  return renderer
}

function buildCamera() {
  const camera = new THREE.PerspectiveCamera(
    70,
    window.innerWidth / window.innerHeight,
    0.05,
    250
  )
  camera.position.copy(CAMERA_POSITION)
  camera.lookAt(TARGET_CENTER)
  return camera
}

function buildLights(scene) {
  const ambient = new THREE.AmbientLight(0xffffff, 0.6)
  const sun = new THREE.DirectionalLight(0xffffff, 1.1)
  sun.position.set(12, 22, 8)
  sun.target.position.set(0, 0, -10)
  scene.add(ambient, sun, sun.target)
}

function buildGround() {
  const geometry = new THREE.PlaneGeometry(200, 200)
  const material = new THREE.MeshStandardMaterial({
    color: GROUND_COLOR,
    roughness: 0.95,
    metalness: 0,
  })
  const ground = new THREE.Mesh(geometry, material)
  ground.rotation.x = -Math.PI / 2
  return ground
}

function buildTargetStand() {
  const postHeight = TARGET_CENTER.y
  const geometry = new THREE.CylinderGeometry(0.05, 0.08, postHeight, 10)
  const material = new THREE.MeshStandardMaterial({
    color: 0x4a3a2a,
    roughness: 0.85,
  })
  const post = new THREE.Mesh(geometry, material)
  post.position.set(TARGET_CENTER.x, postHeight / 2, TARGET_CENTER.z)
  return post
}

function buildTargetBoard() {
  const group = new THREE.Group()
  group.position.copy(TARGET_CENTER)

  const backingGeometry = new THREE.CircleGeometry(
    TARGET_OUTER_RADIUS + 0.04,
    48
  )
  const backingMaterial = new THREE.MeshStandardMaterial({
    color: 0x3a2f22,
    roughness: 0.9,
  })
  const backing = new THREE.Mesh(backingGeometry, backingMaterial)
  group.add(backing)

  const ringWidth = TARGET_OUTER_RADIUS / RING_COUNT
  for (let i = 0; i < RING_COUNT; i += 1) {
    const outerRadius = TARGET_OUTER_RADIUS - i * ringWidth
    const innerRadius = outerRadius - ringWidth
    const isCenter = i === RING_COUNT - 1
    const geometry = isCenter
      ? new THREE.CircleGeometry(outerRadius, 48)
      : new THREE.RingGeometry(innerRadius, outerRadius, 48)
    const material = new THREE.MeshStandardMaterial({
      color: RING_COLORS[i],
      roughness: 0.6,
      side: THREE.DoubleSide,
    })
    const ring = new THREE.Mesh(geometry, material)
    ring.position.z = (i + 1) * RING_Z_STEP
    group.add(ring)
  }

  return group
}

function buildBall() {
  const geometry = new THREE.SphereGeometry(BALL_RADIUS, 24, 16)
  const material = new THREE.MeshStandardMaterial({
    color: 0xf5f5f0,
    roughness: 0.5,
    metalness: 0.05,
  })
  return new THREE.Mesh(geometry, material)
}

function buildArmRig(ball) {
  const group = new THREE.Group()
  group.position.copy(SHOULDER_POSITION)

  const skin = new THREE.MeshStandardMaterial({
    color: SKIN_COLOR,
    roughness: 0.72,
    metalness: 0,
  })

  const forearmGeometry = new THREE.CylinderGeometry(
    FOREARM_TOP_RADIUS,
    FOREARM_TIP_RADIUS,
    ARM_LENGTH,
    16
  )
  const forearm = new THREE.Mesh(forearmGeometry, skin)
  forearm.position.set(0, -ARM_LENGTH / 2, 0)
  group.add(forearm)

  const hand = new THREE.Mesh(new THREE.SphereGeometry(HAND_RADIUS, 20, 14), skin)
  hand.position.set(0, -ARM_LENGTH, 0)
  group.add(hand)

  ball.position.copy(BALL_HOLD_OFFSET)
  group.add(ball)

  return group
}

function createArmRig(ball) {
  const group = buildArmRig(ball)

  function setRotation(q) {
    if (q === null || typeof q !== 'object') {
      return
    }
    if (!Number.isFinite(q.x) || !Number.isFinite(q.y) || !Number.isFinite(q.z) || !Number.isFinite(q.w)) {
      return
    }
    group.quaternion.set(q.x, q.y, q.z, q.w)
  }

  return { group, setRotation }
}

export function buildScene() {
  const scene = new THREE.Scene()
  scene.background = new THREE.Color(SKY_COLOR)
  scene.fog = new THREE.Fog(SKY_COLOR, 25, 160)

  buildLights(scene)

  const ground = buildGround()
  scene.add(ground)

  const targetStand = buildTargetStand()
  scene.add(targetStand)

  const targetBoard = buildTargetBoard()
  scene.add(targetBoard)

  const ball = buildBall()
  const armRig = createArmRig(ball)
  scene.add(armRig.group)

  const camera = buildCamera()
  const renderer = buildRenderer()

  return { scene, camera, renderer, ball, armRig }
}
