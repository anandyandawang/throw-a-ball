# Fixtures

This directory contains recorded IMU traces in JSON format for testing and replay of the throw-a-ball pipeline.

## Trace format

A trace is a JSON array of samples, one per recorded motion event. Each sample:

```json
{
  "timeStamp": 0,
  "rotationRate": { "x": 0.1, "y": 0.2, "z": 0.3 },
  "accelerationIncludingGravity": { "x": 0.5, "y": -9.8, "z": 0.3 },
  "acceleration": { "x": 0.5, "y": 0.0, "z": 0.3 },
  "orientation": { "alpha": 12.5, "beta": -3.2, "gamma": 88.1 }
}
```

- `timeStamp`: milliseconds, relative to the first sample in the trace (the first sample is `0`).
- `rotationRate`: gyroscope output in rad/s (x, y, z), or `null`. The recorder normalizes this to rad/s at capture time using the runtime's calibrated gyro unit (see `sensor-pipeline.js`'s `resolvedGyroUnit`/`forceGyroUnitDecision`), so downstream consumers never need to guess or convert units.
- `accelerationIncludingGravity`: raw accelerometer reading including gravity, in m/s² (x, y, z), as reported by the device.
- `acceleration`: raw gravity-removed acceleration in m/s² (x, y, z), or `null` if the device doesn't report it.
- `orientation`: the latest `deviceorientation` Euler angles (`alpha`, `beta`, `gamma`, in degrees) seen at the time of this motion sample, or `null` if no orientation event had arrived yet.

## Provenance

Traces are recorded on the phone page (M2) using the **Record Trace** button on the capture screen. Recording captures raw `devicemotion`/`deviceorientation` samples as they arrive, and on stop the browser downloads a file named `imu-trace-<epoch-ms>.json` (epoch milliseconds at record start).

## Contents

Real recorded throw traces (strong throws, weak throws, sidearm, non-throws, clipped sensors) arrive in later milestones. M0 is the skeleton only.
