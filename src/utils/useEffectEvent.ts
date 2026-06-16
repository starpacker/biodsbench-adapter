// Polyfill for useEffectEvent (experimental React hook)
import { useCallback, useRef, useLayoutEffect } from 'react';

export function useEffectEvent(fn) {
  const ref = useRef(fn);
  
  useLayoutEffect(() => {
    ref.current = fn;
  });
  
  return useCallback((...args) => {
    const f = ref.current;
    return f(...args);
  }, []);
}
