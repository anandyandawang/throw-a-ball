# session prompts

One prompt per fresh Claude Code session, run in order. Each session assumes `main` already contains every previous milestone, so merge each PR before starting the next. Every prompt tells the session to read `BUILD_PLAN.md` first — that file is the source of truth; the prompts only scope the work.

## Session 1 — M0: skeleton + deploy

```
Read BUILD_PLAN.md at the repo root first — it is the source of truth for every decision. Build milestone M0 only.

- Create the repo layout from §2: /index.html, /js/, /phone/index.html, /phone/js/, /shared/protocol.js, /fixtures/, /test/.
- three.js pinned to an exact 0.185.x version via an ES-module import map from jsDelivr. No bundler, no npm, no build step — plain static files.
- Desktop page: minimal first-person scene per §5.2 — ground plane, ringed target board at pitching distance, ambient + directional light, a ball mesh held in a fixed hand position, sky/fog for depth.
- Phone page: placeholder start screen with the project name and a disabled Start button.
- Set up GitHub Pages deploy-from-branch (root). If enabling Pages needs a repo-settings step you can't do via API, print exact instructions for me.
- Verify headlessly: load both pages in headless Chromium, screenshot them, assert zero console errors.

Do not implement pairing, sensors, or physics yet. When the scene renders, capture screenshots/a short video, send them to me, and wait for my signoff before opening a PR.
```

## Session 2 — M1: pairing

```
Read BUILD_PLAN.md first. main already has the M0 skeleton. Build milestone M1 only: phone↔desktop pairing per §1, §3, §5.

- Desktop: on load create a PeerJS peer (pinned version via script tag), render a QR code (qrcodejs, single script tag) encoding phone/?peer=<id>, plus the raw link as text fallback. Visible connection states — waiting / connecting / connected / retrying — with automatic retry and backoff (§8: the free PeerJS cloud can take 1–20s or need retries).
- Phone: read ?peer=, connect with {reliable: false, serialization: "none"} per §3, same states.
- shared/protocol.js: hello (version check), ping/pong, and a tap test message.
- Desktop HUD shows measured round-trip latency and connection status.
- Verify headlessly: open both pages in two headless Chromium contexts in this container, confirm they pair via the real PeerJS cloud, tap on the phone page visibly registers on the desktop page, latency displays.

Do not start sensor work. Record a short video of the two pages pairing and the tap test, send it, wait for my signoff before the PR.
```

## Session 3 — M2: sensor capture

```
Read BUILD_PLAN.md first. main has pairing working. Build milestone M2 only: the phone sensor layer per §4.1–§4.2.

- One Start tap must, in the same gesture handler: iOS requestPermission() for DeviceMotionEvent and DeviceOrientationEvent (feature-detected, called before any await), screen wake lock (re-acquired on visibilitychange), fullscreen. Explicit denied-state UI with iOS settings instructions.
- CSS armor: overscroll-behavior none, touch-action none on the active surface, user-select none, -webkit-touch-callout none, plus a touchmove preventDefault fallback.
- Safety screen before capture: strap or grip the phone, never let go. Shown every session.
- Live debug readout: quaternion, accel, gyro, sample rate. Use event.timeStamp deltas, clamp dt to 1–50 ms. Runtime unit calibration for rotationRate (Chrome rad/s vs spec deg/s, §4.2).
- Add a Record Trace button: capture raw samples to a downloadable JSON matching the /fixtures/ shape, so I can record real throws on my phone for later milestones.
- This container has no real sensors: unit-test the capture pipeline by injecting synthetic devicemotion/deviceorientation events, and print me a short manual test checklist for iPhone + Android.

Do not build fusion or streaming yet. Demo video of the synthetic-event debug readout, my signoff, then PR.
```

## Session 4 — M3: live hand

```
Read BUILD_PLAN.md first. main has sensors captured on the phone. Build milestone M3 only: fusion, sync, streaming, and the live in-game hand per §4.3 (items 1–4), §4.4, §5.1.

- Phone: complementary filter (gyro-integrated quaternion, accel tilt correction, no compass ever), ZUPT rest detection, and the §4.4 canonical-hold sync snapshot — big Sync button, gravity sanity check that rejects a wrong hold, q_ref in localStorage.
- Phone streams pose packets at sensor rate per §3 (binary Float32Array: quaternion, hand-speed proxy, seq, timestamp). Desktop drops stale packets.
- Desktop: implement the HandInput port and all three adapters from §5.1 — PhoneAdapter wrapping the existing connection, ReplayAdapter playing /fixtures/ traces, ScriptedAdapter with parameterized procedural swings and mouse-drag control, selected via ?input=. The arm rig applies q·q_ref⁻¹ to a neutral ready-arm pose (§4.3.4): fixed shoulder, forearm ~0.3 m, hand at the arm tip.
- Ship at least one synthetic fixture trace. Unit-test the fusion math (pure functions) in /test/.
- Verify headlessly: run the desktop page with ?input=replay and ?input=scripted, record the arm swinging.

Do not build release detection or ball flight. Demo video via ScriptedAdapter, my signoff, then PR.
```

## Session 5 — M4: the throw

```
Read BUILD_PLAN.md first. main has the live hand. Build milestone M4 only: release detection and ball flight per §4.3 (items 5–7), §5.2.

- Phone: the IDLE→SWINGING→RELEASED state machine exactly as §4.3.5 — accel start threshold with debounce, running peak sample recording, hysteresis + minimum swing duration + minimum-throw floor, and computing the throw from the recorded peak sample, never the detection sample. Pure functions in their own module, unit-tested against /fixtures/ traces (real ones if I've committed them, synthetic otherwise): deliberate throws fire, wrist flicks and repositioning do not.
- Throw message per §3 with spin (gyro at release, world frame, gain + clip handling per §4.3.6). Release feedback per §4.3.7: navigator.vibrate(40) on Android, screen flash on iOS.
- Desktop: on throw, spawn the ball with velocity + spin; semi-implicit Euler with gravity, quadratic drag (Cd ≈ 0.35), Magnus lift from spin with slow decay (§5.2); swept-ray hit test against the target so fast balls can't tunnel; hit/miss result.
- Wire ScriptedAdapter and ReplayAdapter through the same path so a scripted throw flies and hits.

Demo video: several scripted throws of different speeds/spins hitting and missing the target. My signoff, then PR.
```

## Session 6 — M5: training loop

```
Read BUILD_PLAN.md first. main has throws flying. Build milestone M5 only: the training loop per §5.2 and §6 M5.

- HUD (DOM overlay, pointer-events none): big last-throw speed in mph and km/h, session best, throw count, ring score. Style it readable from across a room.
- Target scoring rings with per-ring points, hit flash, miss feedback, running session score.
- Ball feed loop: after each throw resolves (hit, miss, or ground), a new ball appears in the hand ~1 s later, forever.
- Gain calibration pass per §4.3.6: map clamped peak hand speed (~0.5–10 m/s) to ball speed (~20–45 m/s) with a tunable curve. Put every tunable (thresholds, gains, filter constants) in one shared config module with a ?debug=1 panel that live-edits them, so real-device tuning is fast.
- Extend ScriptedAdapter with a sweep mode that fires a series of throws from weak to strong, and verify headlessly that the meter ranks them monotonically.

Demo video: the sweep — meter climbing, rings scoring, balls auto-feeding. My signoff, then PR.
```

## Session 7 — M6: polish

```
Read BUILD_PLAN.md first. main has the full training loop. Build milestone M6 only: hardening per §6 M6 and §8.

- Reconnect handling on both ends: dropped peer connection shows a reconnect state and recovers without a page reload; the desktop QR reappears if the phone is gone for good.
- Wake-lock re-acquire on visibilitychange; capture state machine resets cleanly if the phone backgrounds mid-swing (§4.2).
- Detect a TURN-relayed (non-P2P) connection and show a small latency notice (§8).
- Denied-permission UI, the every-session safety screen, and a left-handed mirrored toggle if it's cheap — otherwise leave it noted as post-MVP.
- README.md: what this is, the play-it-now URL flow (open desktop page, scan QR, sync, throw), a troubleshooting section (pairing slow, sensors denied, guest Wi-Fi isolation), and a development section (adapters, fixtures, tests).
- Full headless regression: pairing, replay throw, scripted sweep, zero console errors on both pages.

Demo video of the whole flow via adapters, my signoff, then PR.
```

## Session 8 — real-device tuning (run after you've played it)

```
Read BUILD_PLAN.md first. I've now played the game on my real phone and recorded traces with the Record Trace button. Attached/committed under /fixtures/ are my real throw traces, and here is what felt wrong: <describe: e.g. throws fire too early / too hard to trigger / speed feels wrong / hand lags>.

- Replay my traces through the pipeline in /test/ and diagnose each complaint against the actual numbers (thresholds vs my peaks, filter lag, gain curve).
- Tune the config constants to fit my traces, keeping the §4.3 invariants (peak backdating, hysteresis, clamps).
- Show before/after: for each of my traces, what the old and new pipeline computed (fired or not, speed, direction).
- Add any of my traces that exposed a bug as named regression fixtures.

Demo video replaying my real traces with the tuned pipeline, my signoff, then PR.
```
