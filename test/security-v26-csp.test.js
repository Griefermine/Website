/**
 * Security Test V26: Content Security Policy
 *
 * Verifiziert, dass die CSP Header korrekt konfiguriert sind.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { APP_CSP } from '../server/manager.js';

describe('Security V26: Content Security Policy', () => {
  it('should have strict default-src', () => {
    assert(
      APP_CSP.includes("default-src 'none'"),
      'CSP should have default-src set to none',
    );
  });

  it('should have script-src limited to self', () => {
    assert(
      APP_CSP.includes("script-src 'self'"),
      'CSP should limit script-src to self only',
    );

    assert(
      !APP_CSP.includes("script-src 'unsafe-inline'"),
      'CSP should not allow unsafe-inline for scripts',
    );

    assert(
      !APP_CSP.includes("script-src 'unsafe-eval'"),
      'CSP should not allow unsafe-eval for scripts',
    );
  });

  it('should minimize unsafe-inline in style-src', () => {
    // Note: unsafe-inline is allowed for styles (common practice for inline styles)
    // but we verify it's limited to styles only
    assert(
      APP_CSP.includes("style-src 'self' 'unsafe-inline'"),
      'CSP should allow unsafe-inline only for styles',
    );
  });

  it('should have frame-ancestors set to none', () => {
    assert(
      APP_CSP.includes("frame-ancestors 'none'"),
      'CSP should prevent framing with frame-ancestors none',
    );
  });

  it('should have object-src set to none', () => {
    assert(
      APP_CSP.includes("object-src 'none'"),
      'CSP should block plugins with object-src none',
    );
  });

  it('should have base-uri set to self', () => {
    assert(
      APP_CSP.includes("base-uri 'self'"),
      'CSP should restrict base-uri to self',
    );
  });

  it('should limit connect-src to self', () => {
    assert(
      APP_CSP.includes("connect-src 'self'"),
      'CSP should limit connect-src to self only',
    );

    assert(
      !APP_CSP.includes('connect-src http:'),
      'CSP should not allow arbitrary HTTP connections',
    );

    assert(
      !APP_CSP.includes('connect-src https:'),
      'CSP should not allow arbitrary HTTPS connections',
    );
  });

  it('should allow data: and blob: for images', () => {
    assert(
      APP_CSP.includes("img-src 'self' data: blob:"),
      'CSP should allow data: and blob: for images',
    );
  });

  it('should limit font-src to self', () => {
    assert(
      APP_CSP.includes("font-src 'self'"),
      'CSP should limit font-src to self only',
    );
  });

  it('should have form-action set to self', () => {
    assert(
      APP_CSP.includes("form-action 'self'"),
      'CSP should restrict form-action to self',
    );
  });
});
