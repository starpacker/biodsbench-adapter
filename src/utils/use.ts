// Polyfill for React.use() (React 19 feature)
import { useContext } from 'react';

export function use(resource) {
  // If it's a Context, use useContext
  if (resource && resource.$$typeof === Symbol.for('react.context')) {
    return useContext(resource);
  }
  
  // If it's a Promise, throw it (Suspense will catch it)
  if (resource && typeof resource.then === 'function') {
    throw resource;
  }
  
  // Otherwise, return the resource as-is
  return resource;
}
