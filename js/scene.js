import * as THREE from 'three'

const SKY_COLOR = 0x87ceeb
const GROUND_COLOR = 0x6b8f4e
const TARGET_CENTER = new THREE.Vector3(0, 1.2, -18.44)
const CAMERA_POSITION = new THREE.Vector3(0, 1.7, 0)
const BALL_POSITION = new THREE.Vector3(0.26, 1.4, -0.62)
const BALL_RADIUS = 0.037

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
  const ball = new THREE.Mesh(geometry, material)
  ball.position.copy(BALL_POSITION)
  return ball
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
  scene.add(ball)

  const camera = buildCamera()
  const renderer = buildRenderer()

  return { scene, camera, renderer, ball }
}
