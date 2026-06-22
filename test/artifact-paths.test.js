import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { apiRoot } from '../src/artifact-paths.js';

describe('artifact-paths', () => {
  describe('apiRoot', () => {
    it('exports the API root directory path', () => {
      expect(apiRoot).toBeDefined();
      expect(typeof apiRoot).toBe('string');
      expect(path.isAbsolute(apiRoot)).toBe(true);
    });

    it('points to the parent directory of src', () => {
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);
      const expectedRoot = path.resolve(__dirname, '..');
      
      expect(apiRoot).toBe(expectedRoot);
    });

    it('is a valid directory path', () => {
      // Should not throw when used in path operations
      expect(() => path.join(apiRoot, 'src')).not.toThrow();
      expect(() => path.resolve(apiRoot, 'package.json')).not.toThrow();
    });
  });
});
