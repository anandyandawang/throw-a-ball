export const SIGNALING_PARAM_KEYS = Object.freeze(['host', 'port', 'path', 'key', 'insecure']);

export function peerOptionsFromSearch(search) {
  const params = new URLSearchParams(search);
  const host = params.get('host');

  if (host === null) {
    return {};
  }

  const options = { host };

  const port = params.get('port');
  if (port !== null) {
    options.port = Number(port);
  }

  const path = params.get('path');
  if (path !== null) {
    options.path = path;
  }

  const key = params.get('key');
  if (key !== null) {
    options.key = key;
  }

  if (params.get('insecure') === '1') {
    options.secure = false;
  }

  return options;
}

export function signalingQueryEntries(search) {
  const params = new URLSearchParams(search);
  const entries = [];

  for (const key of SIGNALING_PARAM_KEYS) {
    if (params.has(key)) {
      entries.push([key, params.get(key)]);
    }
  }

  return entries;
}
