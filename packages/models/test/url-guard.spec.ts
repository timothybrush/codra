import { describe, expect, it } from 'vitest';
import { assertPublicBaseUrl, isPrivateHost, isValidPublicUrl } from '../src/url-guard';
import { ProviderRequestError } from '@codra/models/types';

// A provider's base URL comes from the dashboard and is then fetched server-side, so an unguarded
// adapter turns that form into an SSRF primitive.
//
// The guard existed in the Google and OpenAI adapters and was simply missing from Anthropic, which
// fetched `config.baseUrl` unchecked - the copy-paste is why nobody noticed. These tests cover the
// shared module so all three are protected by the same assertions.
describe('provider base URL guard', () => {
  it('rejects loopback, link-local and RFC1918 hosts', () => {
    const blocked = [
      'http://127.0.0.1/v1',
      'http://localhost:8080/v1',
      'http://10.0.0.5/v1',
      'http://192.168.1.1/v1',
      'http://172.16.0.1/v1',
      'http://172.31.255.255/v1',
      // 169.254.0.0/16 is where the AWS/Azure metadata service lives.
      'http://169.254.169.254/latest/meta-data',
    ];
    for (const url of blocked) {
      expect(isValidPublicUrl(url), url).toBe(false);
    }
  });

  // The original guard carried `/^::1$/`, which never matched: `URL.hostname` returns an IPv6
  // literal with its brackets ("[::1]"). IPv6 loopback and the unique-local/link-local ranges were
  // therefore reachable in both adapters that had a guard at all.
  it('rejects IPv6 private ranges, brackets and all', () => {
    const blocked = [
      'http://[::1]/v1',
      'http://[::]/v1',
      'http://[fc00::1]/v1',
      'http://[fd12:3456::1]/v1',
      'http://[fe80::1]/v1',
      'http://[::ffff:127.0.0.1]/v1',
    ];
    for (const url of blocked) {
      expect(isValidPublicUrl(url), url).toBe(false);
    }
    // A genuinely public IPv6 address must still pass.
    expect(isValidPublicUrl('http://[2606:4700::1111]/v1')).toBe(true);
  });

  // Public-looking names that resolve only from inside a cloud instance, so the range checks alone
  // would let them through.
  it('rejects cloud metadata endpoints by name', () => {
    expect(isValidPublicUrl('http://metadata.google.internal/computeMetadata/v1')).toBe(false);
    expect(isValidPublicUrl('http://100.100.100.200/latest/meta-data')).toBe(false);
  });

  it('rejects non-HTTP schemes and unparseable input', () => {
    expect(isValidPublicUrl('file:///etc/passwd')).toBe(false);
    expect(isValidPublicUrl('ftp://example.com')).toBe(false);
    expect(isValidPublicUrl('not a url')).toBe(false);
    expect(isValidPublicUrl('')).toBe(false);
  });

  it('allows genuine public endpoints', () => {
    expect(isValidPublicUrl('https://api.anthropic.com/v1')).toBe(true);
    expect(isValidPublicUrl('https://generativelanguage.googleapis.com/v1beta')).toBe(true);
    expect(isValidPublicUrl('https://api.openai.com/v1')).toBe(true);
    // 172.32 is outside the private 172.16-172.31 block, so the range regex must not over-match.
    expect(isValidPublicUrl('http://172.32.0.1/v1')).toBe(true);
  });

  it('classifies hosts without needing a full URL', () => {
    expect(isPrivateHost('127.0.0.1')).toBe(true);
    expect(isPrivateHost('172.15.0.1')).toBe(false);
    expect(isPrivateHost('example.com')).toBe(false);
  });

  describe('assertPublicBaseUrl', () => {
    it('throws a provider-shaped 400 for a blocked URL', () => {
      try {
        assertPublicBaseUrl('http://169.254.169.254/', 'Anthropic');
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(ProviderRequestError);
        expect((error as ProviderRequestError).status).toBe(400);
      }
    });

    // Every adapter defaults to its own vendor URL when none is configured, so an absent base URL
    // must pass rather than throw.
    it('accepts an absent base URL', () => {
      expect(() => assertPublicBaseUrl(null, 'Anthropic')).not.toThrow();
      expect(() => assertPublicBaseUrl(undefined, 'Google')).not.toThrow();
      expect(() => assertPublicBaseUrl('', 'OpenAI')).not.toThrow();
    });

    it('accepts a public base URL', () => {
      expect(() => assertPublicBaseUrl('https://api.anthropic.com/v1', 'Anthropic')).not.toThrow();
    });
  });
});
