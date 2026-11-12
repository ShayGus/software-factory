// Compatibility import for BUILD-05's optional scratch demo. Both entry points
// use the same BUILD-12 HTTP boundary; there is no second stub server.
export { createToolkitRequestHandler as createSpikeRequestHandler } from '../dist/src/ui-http.js';
