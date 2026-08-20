# M2 Manual Test Checklist

Real-device checks for phone sensor capture. Run through both sections before signoff.

## iPhone (Safari)

- [ ] Open the phone page over HTTPS
- [ ] Tap **start sensors** — a motion/orientation permission prompt appears
- [ ] Grant permission — safety screen shows "strap or grip the phone" and "never let go" on every reload
- [ ] Tap **begin** — readout streams quaternion/gyro/accel with a plausible sample rate (30-60 Hz)
- [ ] After a few seconds of gentle waving, unit badge reads **deg/s**
- [ ] Wave the phone hard — no page scroll, no rubber-banding, no text selection, no long-press callout
- [ ] Leave the screen untouched for 2+ minutes — screen stays awake
- [ ] Background the tab or lock the screen, then return — readout resumes and the rate recovers
- [ ] Background the tab while sitting on the **safety** screen, then return — the screen still stays awake (the wake lock is re-acquired)
- [ ] Clear the site's website data (Settings > Safari > Advanced > Website Data), reload, tap start, choose **Don't Allow** — denied screen appears with Settings > Safari > Advanced > Website Data recovery steps
- [ ] After clearing website data again, start works and prompts normally
- [ ] Record trace during ~5 s of swings — a JSON file downloads and parses
- [ ] While paired to the desktop, the tap test still works

## Android (Chrome)

- [ ] Open the phone page over HTTPS
- [ ] Tap **start sensors** — no permission prompt appears
- [ ] Safety screen shows "strap or grip the phone" and "never let go" on every reload
- [ ] Tap **begin** — readout streams quaternion/gyro/accel with a plausible sample rate (30-60 Hz)
- [ ] After a few seconds of gentle waving, unit badge reads **rad/s**
- [ ] Wave the phone hard — no page scroll, no rubber-banding, no text selection, no long-press callout
- [ ] Leave the screen untouched for 2+ minutes — screen stays awake
- [ ] Background the tab or lock the screen, then return — readout resumes and the rate recovers
- [ ] Background the tab while sitting on the **safety** screen, then return — the screen still stays awake (the wake lock is re-acquired)
- [ ] Block **Motion sensors** for this site (Chrome > site settings), reload, tap start — there is still no prompt and the safety screen appears, then **begin** shows the capture screen's "no sensor data — this browser may be blocking motion sensors" notice within ~2 s
- [ ] Re-allow motion sensors in site settings, reload — the notice stays away and the readout streams again
- [ ] Record trace during ~5 s of swings — a JSON file downloads and parses
- [ ] While paired to the desktop, the tap test still works
