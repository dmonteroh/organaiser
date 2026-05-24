// Delays running `fn` until `wait` milliseconds have passed without a new call.
// Trailing-edge: only the last call in a burst runs, `wait` ms after it. Each
// call resets the timer, so a pending invocation is rescheduled rather than
// stacked. Mirrors the throttle helper's shape and test style.
export function debounce(fn, wait) {
  let timer = null;
  return function debounced(...args) {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      fn.apply(this, args);
    }, wait);
  };
}
