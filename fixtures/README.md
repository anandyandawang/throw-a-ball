# Fixtures

This directory contains recorded IMU traces in JSON format for testing and replay of the throw-a-ball pipeline.

## Trace format

A trace is a JSON array of samples. Each sample contains:

```json
{
  "timeStamp": 1234567890.123,
  "rotationRate": { "x": 0.1, "y": 0.2, "z": 0.3 },
  "accelerationIncludingGravity": { "x": 0.5, "y": -9.8, "z": 0.3 },
  "acceleration": { "x": 0.5, "y": 0.0, "z": 0.3 }
}
```

- `timeStamp`: milliseconds or seconds (context-dependent), absolute or relative to trace start
- `rotationRate`: gyroscope output in rad/s (x, y, z)
- `accelerationIncludingGravity`: accelerometer including gravity in m/s²
- `acceleration`: gravity-removed acceleration in m/s² (optional; use `accelerationIncludingGravity` if null)

## Contents

Real recorded traces (strong throws, weak throws, sidearm, non-throws, clipped sensors) arrive in later milestones. M0 is the skeleton only.
