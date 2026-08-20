export const HandInputEvent = Object.freeze({
  POSE: 'pose',
  SYNC: 'sync',
  THROW: 'throw',
})

function noopUnsubscribe() {}

export function createHandInputEmitter() {
  const handlersByEvent = new Map()

  function on(eventName, handler) {
    if (typeof handler !== 'function') {
      return noopUnsubscribe
    }
    const existing = handlersByEvent.get(eventName)
    if (existing === undefined) {
      handlersByEvent.set(eventName, [handler])
    } else {
      existing.push(handler)
    }
    return function off() {
      const registered = handlersByEvent.get(eventName)
      if (registered === undefined) {
        return
      }
      const position = registered.indexOf(handler)
      if (position >= 0) {
        registered.splice(position, 1)
      }
    }
  }

  function emit(eventName, payload) {
    const registered = handlersByEvent.get(eventName)
    if (registered === undefined || registered.length === 0) {
      return
    }
    for (const handler of registered.slice()) {
      handler(payload)
    }
  }

  return { on, emit }
}
