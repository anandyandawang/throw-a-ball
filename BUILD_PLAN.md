# throw-a-ball — build plan

A browser-only, phone-as-the-ball pitching trainer. The desktop browser shows a first-person 3D scene with a target; the phone browser reads its own motion sensors and acts as the ball in your hand. Swing the phone, the in-game hand swings; throw (without letting go!), the game detects the release, launches the ball with realistic physics, and shows the speed on a meter. Both pages are static files hosted on GitHub Pages — no backend at all.

## 1. Architecture

| Piece | Choice | Why |
|---|---|---|
| Hosting | GitHub Pages, one repo, one origin | Free HTTPS (sensor APIs require a secure context), zero infra |
| Desktop screen | Browser page with three.js (pinned `0.185.x`) via ES-module import map from jsDelivr | No build step, no bundler, no base-path bugs on Pages |
| Phone controller | Plain HTML/JS page using `devicemotion` + `deviceorientation` | The only motion APIs iOS Safari supports (Generic Sensor API is Chrome-only) |
| Transport | WebRTC DataChannel via PeerJS (public cloud signaling, built-in STUN + free TURN) | Zero backend; P2P on the same LAN gives single-digit-ms latency; TURN fallback covers hostile networks |
| Pairing | Desktop shows a QR code encoding `phone/?peer=<id>`; phone scans and connects | One-tap pairing; `qrcodejs` is a single script tag |
| Physics/fusion | Runs **on the phone**; desktop receives pose + discrete throw events | Fusion and release detection need full-rate, in-order samples; the network only carries results |

### Why not the earlier ideas

- **Native/libGDX desktop app**: an HTTPS phone page cannot open plain `ws://` to a LAN app (mixed content, no override), and `wss://` with a self-signed cert requires installing a CA profile on the phone — iOS Safari's WebSocket stack rejects self-signed certs even after the page warning is accepted. Browser-to-browser WebRTC sidesteps the entire certificate problem.
- **Generic Sensor API**: not implemented in WebKit, so unavailable on every iOS browser.

## 2. Repo layout

```
/index.html          desktop game page
/js/                 desktop game modules (scene, ball flight, hud, pairing)
/phone/index.html    phone controller page
/phone/js/           sensor capture, fusion, release detection, connection
/shared/protocol.js  message types + payload shapes imported by both pages
/fixtures/           recorded IMU traces (JSON) for replay + unit tests
/test/               unit tests for the pure-function pipeline
```

Both pages deploy under one origin (`<user>.github.io/throw-a-ball/` and `.../phone/`). Pages source: deploy from branch, root — nothing to build.

## 3. Wire protocol (`shared/protocol.js`)

PeerJS `DataConnection` opened with `{ reliable: false, serialization: "none" }` (unordered, unreliable — stale pose packets drop instead of queueing). Two message kinds:

- **`pose`** (~60 Hz, binary `Float32Array`): orientation quaternion (4), hand-speed proxy (1), sequence number (1), phone timestamp (1). Desktop drops any packet older than the last one rendered.
- **`throw`** (discrete, sent 3× for loss-resistance with a dedupe id, or over a second reliable channel): release direction unit vector (world frame), release speed (m/s), peak hand speed, swing duration, release timestamp.

Plus JSON control messages on connect: `hello` (version check), `ping`/`pong` (latency display), `reset`.

## 4. Phone page

### 4.1 Start flow (everything gated on one tap)

A single **Start** button tap must, in the same gesture handler:
1. Call `DeviceMotionEvent.requestPermission()` and `DeviceOrientationEvent.requestPermission()` when they exist (iOS 13+; feature-detect with `typeof DeviceMotionEvent.requestPermission === 'function'`). Call them first — an `await` before them can lose the transient activation.
2. Request `navigator.wakeLock.request('screen')`, re-acquire on `visibilitychange`.
3. Request fullscreen, lock to portrait where supported.

Denied-permission state gets explicit UI (iOS offers no re-prompt; the user must reset it in Settings).

CSS armor for violent swinging: `overscroll-behavior: none`, `touch-action: none` on the active surface, `user-select: none`, `-webkit-touch-callout: none`, plus a `touchmove` `preventDefault()` fallback for older iOS rubber-banding.

**Safety screen before first throw: "strap or grip the phone — do NOT let go." Shown every session.**

### 4.2 Sensor handling

- Primary inputs: `devicemotion.rotationRate` (gyro) and `devicemotion.accelerationIncludingGravity`; use gravity-removed `acceleration` when non-null, otherwise subtract gravity via the orientation quaternion.
- ~60 Hz nominal, never guaranteed: integrate with real `event.timeStamp` deltas, clamp `dt` to 1–50 ms.
- Runtime unit calibration for `rotationRate`: Chrome historically reports rad/s where the spec says deg/s. Detect at rest+slow-motion startup (values ~57× apart) instead of hardcoding.
- Treat samples pinned at the accelerometer ceiling (±8–16 g typical) as max effort, not literal values.
- Backgrounding/screen-lock silently stops events: watch `visibilitychange` and reset the capture state machine.

### 4.3 Fusion + throw pipeline (pure functions, unit-testable)

1. **Orientation**: own complementary filter — integrate gyro into quaternion `q`, nudge pitch/roll toward the accelerometer's gravity direction with a small gain. **No compass ever** (iOS doesn't fuse it, it drifts near electronics). Yaw is gyro-only in an arbitrary "game frame", re-zeroed whenever the phone is at rest.
2. **World-frame linear acceleration**: rotate device acceleration by `q`, subtract gravity.
3. **Hand velocity**: leaky integrator (`λ ≈ 0.98`) over high-passed world acceleration, plus the low-noise tangential proxy `v_t = |ω| × L_arm`. Zero-velocity update: when accel and gyro magnitudes stay under rest thresholds for ~120 ms, force `v = 0` and re-zero yaw.
4. **Hand pose for rendering**: forward kinematics off orientation only — fixed shoulder anchor, virtual forearm `L_arm ≈ 0.3 m`, `p_hand = p_shoulder + R(q)·(0,0,−L)`. Integrated position is at most a 10–20 % garnish on top; never the primary driver (double integration drifts meters within a second).
5. **Release state machine**: `IDLE → SWINGING` when world linear accel exceeds ~15 m/s² for 2–3 consecutive samples. During `SWINGING`, record the running peak sample (quaternion, velocity, timestamp). `SWINGING → RELEASED` when speed drops 3–5 % below peak for 2 consecutive samples, swing lasted ≥ 80 ms, and peak exceeded a minimum-throw floor. **Compute the throw from the recorded peak sample**, not the detection sample (detection lags the true peak by 1–3 frames). This mirrors real biomechanics: pitchers release essentially at peak hand speed, and peak timing is consistent across skill levels — only magnitude differs, so thresholds are fixed and gain carries the skill signal.
6. **Throw vector**: direction = normalized hand-velocity direction at peak (blend toward the device-pointing axis when confidence is low); speed = calibrated monotone mapping from clamped peak hand speed (~0.5–10 m/s measured) to game ball speed (~20–45 m/s), tuned by playtesting rather than lever-arm math.

## 5. Desktop page

- **Scene**: `PerspectiveCamera` at the pitcher's position, ground plane, ringed target board at regulation-ish distance, visible arm/hand holding a ball, sky/fog for depth. Lighting: ambient + one directional.
- **Hand rendering**: apply the streamed quaternion to the arm rig; hold-last-value with ≤ 50 ms slerp extrapolation from the last gyro rate. Convert device orientation with the proper quaternion math (vendor the old `DeviceOrientationControls` conversion), never raw Euler angles.
- **Ball flight**: on a `throw` message, spawn the ball at the hand with the received velocity; per-frame `v.y -= g·dt; pos += v·dt`, optional drag later. Hit test: sphere-vs-target-plane distance plus a swept raycast from previous to current position so fast balls can't tunnel through the board.
- **Feed loop**: after each throw resolves (hit, miss, or ground), a new ball appears in the hand ~1 s later. Score rings on the target; hit/miss flash.
- **HUD**: absolutely-positioned DOM over the canvas (`pointer-events: none`): big last-throw speed in mph/km/h, session best, ring score, connection status, measured round-trip latency.
- **Pairing panel**: on load, `new Peer()` → QR of `phone/?peer=<id>` (via `qrcodejs`) plus the raw link for manual entry. Visible connecting/retry state with backoff — the free PeerJS cloud can take 1–20 s or need a retry. Reconnect handling on both ends.

## 6. Milestones

Each milestone ends runnable and demoed with a short screen recording (headless Chromium capture works in CI/dev containers).

- **M0 — skeleton + deploy**: repo layout, import-map three.js "hello scene", Pages live. *Accept: both URLs load over HTTPS on desktop and phone.*
- **M1 — pairing**: PeerJS + QR + retry/backoff + ping latency in HUD; phone sends taps, desktop shows them. *Accept: phone tap visibly registers on desktop over the same Wi-Fi, latency shown.*
- **M2 — sensor capture**: permission flow, wake lock, CSS armor, raw sensor debug view on the phone, unit-calibration check. *Accept: quaternion + accel values stream on-screen on iPhone and Android.*
- **M3 — live hand**: pose streaming, desktop arm rig follows the phone in real time. *Accept: swinging the phone swings the in-game hand with no visible lag or axis flips.*
- **M4 — the throw**: release state machine (built against recorded fixtures first), throw event, ballistic flight, target hit/miss. *Accept: a deliberate throw launches the ball; wrist flicks and repositioning do not.*
- **M5 — training loop**: speed meter, scoring rings, auto ball feed, gain calibration so hard/clean throws read fast and lazy ones read slow. *Accept: three testers agree the meter ranks their throws correctly.*
- **M6 — polish**: reconnects, wake-lock re-acquire, denied-permission UI, safety screen, TURN-path notice when relayed (latency warning), README.

## 7. Testing strategy

- The whole phone pipeline (fusion, integrators, state machine) is pure functions of `(sample, state) → state`; unit-test them against `/fixtures/` traces: real recorded throws (strong, weak, sidearm), non-throws (walking, pocket, hand-off), and clipped-sensor throws.
- A desktop **sim mode** (`?sim=1`) replays fixtures or maps mouse drags to fake poses, so the game is developable and CI-testable with no phone.
- Manual device matrix per milestone: one iPhone (Safari), one Android (Chrome).

## 8. Risks

- **PeerJS public cloud reliability**: no SLA, documented slow handshakes. Mitigated by retry UI + manual link; escape hatch is swapping the signaling layer for Trystero — the DataChannel code is unaffected.
- **Guest/hotel Wi-Fi client isolation**: blocks direct P2P; PeerJS's bundled TURN relays cover it at the cost of internet RTT. Detect the relayed path and surface a latency notice.
- **Sensor variance across devices**: sample rate (20–60 Hz on some Android OEMs), unit quirks, saturation. Mitigated by timestamp-delta integration, runtime calibration, clamping, and fixture-driven tuning.
- **The user actually throws the phone.** Safety screen every session, and the game never asks for more speed than a firm indoor swing.
