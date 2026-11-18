import type SharpFunction from 'sharp';

// sharp 0.35's top-level "types" is its ESM typings, which our node10 module resolution picks, while
// require() returns the CommonJS function itself. Drop this once tsconfig moves to module node20/nodenext.
// eslint-disable-next-line @typescript-eslint/no-require-imports
export const sharp: typeof SharpFunction = require('sharp');
