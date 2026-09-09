// Limits how often `fn` can run: at most once per `wait` milliseconds.
// Leading-edge: the first call runs immediately, later calls within the
// window are dropped. This is the existing pattern in this project; new
// timing utilities should match its shape and test style.
export function throttle(fn, wait) {
  let last = 0;
  return function throttled(...args) {
    const now = Date.now();
    if (now - last >= wait) {
      last = now;
      return fn.apply(this, args);
    }
  };
}
