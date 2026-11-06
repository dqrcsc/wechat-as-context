import './support/isolation.ts';
import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { findMediaToolBinary } from '../src/extractor/tool_binary.ts';
import { buildYouTubeResolverEnv } from '../src/extractor/youtube_fallback.ts';

function probe(scenario: object) {
  const child = Bun.spawnSync([process.execPath, 'tests/support/resolver_probe.ts', JSON.stringify(scenario)], {
    cwd: process.cwd(), env: process.env, stdout: 'pipe', stderr: 'pipe',
  });
  expect(child.exitCode).toBe(0);
  if (child.exitCode) throw new Error(child.stderr.toString());
  return JSON.parse(child.stdout.toString());
}

test('actual resolver subprocess preserves explicit proxy configuration without model secrets', () => {
  const env = { HTTPS_PROXY: 'http://proxy.test:8080', https_proxy: 'http://lower.test:8080',
    HTTP_PROXY: '', http_proxy: 'http://proxy.test:8080', ALL_PROXY: 'socks5://proxy.test:1080',
    all_proxy: 'socks5://lower.test:1080', NO_PROXY: 'localhost', no_proxy: '.example.test',
    GEMINI_API_KEY: 'synthetic-secret', NODE_OPTIONS: '--require=untrusted', SSL_CERT_FILE: '/fixture/ca.pem' };
  const { invocation, result } = probe({ env });
  expect(result.reason).toBe('resolver_no_audio');
  for (const key of ['HTTPS_PROXY','https_proxy','HTTP_PROXY','http_proxy','ALL_PROXY','all_proxy','NO_PROXY','no_proxy','SSL_CERT_FILE']) {
    expect(invocation.options.env[key]).toBe((env as any)[key]);
  }
  expect(invocation.options.env.GEMINI_API_KEY).toBeUndefined();
  expect(invocation.options.env.NODE_OPTIONS).toBeUndefined();
  expect(invocation.options.timeout).toBe(45000);
  expect(invocation.args).toContain('--ignore-config');
  expect(invocation.args).not.toContain('--no-check-certificates');
});

for (const [error, stderr, reason] of [
  [{ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true }, '', 'resolver_output_limit'],
  [{ killed: true }, '', 'resolver_timeout'],
  [{ code: 'ENOENT' }, '', 'resolver_not_installed'],
  [{ code: 'EACCES' }, '', 'resolver_not_executable'],
  [{ code: 1 }, 'SSL: CERTIFICATE_VERIFY_FAILED private-url?token=secret', 'resolver_certificate_error'],
  [{ code: 1 }, 'ProxyError: cannot connect user:pass@proxy.test', 'resolver_proxy_error'],
  [{ code: 1 }, 'Unable to download: Connection refused private-url', 'resolver_network_error'],
  [{ code: 1 }, 'HTTP Error 403: Forbidden signed-url?token=secret', 'resolver_http_403'],
  [{ code: 1 }, 'timed out while requesting private-url', 'resolver_timeout'],
  [{ code: 1 }, 'unrecognized private stderr', 'resolver_failed'],
] as const) {
  test(`resolver subprocess failure is sanitized: ${reason}`, () => {
    const { result } = probe({ error, stderr });
    expect(result.reason).toBe(reason);
    expect(result.urls).toEqual([]);
    expect(result.exitCode).toBe(typeof (error as any).code === 'number' ? (error as any).code : undefined);
    expect(JSON.stringify(result)).not.toMatch(/secret|private|user:pass/);
  });
}

test('malformed resolver JSON has its own diagnosis', () => {
  expect(probe({ stdout: '{broken' }).result.reason).toBe('resolver_invalid_output');
});

test('resolver output limit counts UTF-8 bytes and rejects invalid JSON shapes', () => {
  expect(probe({ largeOutput: true }).result.reason).toBe('resolver_output_limit');
  for (const stdout of ['null', '[]', '42']) expect(probe({ stdout }).result.reason).toBe('resolver_invalid_output');
});

test('YouTube quality persists sanitized resolver reason and exit code without stderr', () => {
  const { result } = probe({ extract: true, error: { code: 1 }, stderr: 'ProxyError: user:secret@private-host' });
  expect(result.extractionQuality.status).toBe('metadata_only');
  expect(result.extractionQuality.reasons).toContain('resolver_proxy_error');
  expect(result.extractionQuality.reasons).toContain('resolver_exit_code_1');
  expect(JSON.stringify(result)).not.toMatch(/secret|private-host/);
});

for (const tool of ['yt-dlp', 'ffmpeg', 'local-asr'] as const) {
  test(`${tool}: absolute, home and project-relative overrides resolve to the intended executable`, () => {
    const folder = mkdtempSync(join(homedir(), 'tools-'));
    const binary = join(folder, tool);
    writeFileSync(binary, 'synthetic; never executed'); chmodSync(binary, 0o700);
    expect(findMediaToolBinary(tool, binary)).toBe(binary);
    expect(findMediaToolBinary(tool, `~/${folder.slice(homedir().length + 1)}/${tool}`)).toBe(binary);
    expect(findMediaToolBinary(tool, `./${tool}`, folder)).toBe(binary);
  });
  test(`${tool}: defaults include local bin; invalid explicit paths cannot select that fallback`, () => {
    const binDir = join(homedir(), '.local/bin'); mkdirSync(binDir, { recursive: true });
    const binary = join(binDir, tool);
    writeFileSync(binary, 'synthetic; never executed'); chmodSync(binary, 0o700);
    expect(findMediaToolBinary(tool)).toBe(binary);
    expect(() => findMediaToolBinary(tool, '~/missing-tool')).toThrow(`${tool}_not_found`);
    expect(() => findMediaToolBinary(tool, '~somebody/bin/tool')).toThrow(`${tool}_invalid_path`);
    expect(() => findMediaToolBinary(tool, binDir)).toThrow(`${tool}_not_executable`);
    const noExec = join(mkdtempSync(join(tmpdir(), 'no-exec-')), tool);
    writeFileSync(noExec, 'no execute permission'); chmodSync(noExec, 0o600);
    expect(() => findMediaToolBinary(tool, noExec)).toThrow(`${tool}_not_executable`);
  });
}

test('CA environment covers absent system bundle and explicit file/directory without exposing other keys', () => {
  expect(buildYouTubeResolverEnv({}, false).SSL_CERT_FILE).toBeUndefined();
  expect(buildYouTubeResolverEnv({}, true).SSL_CERT_FILE).toBe('/etc/ssl/cert.pem');
  const env = buildYouTubeResolverEnv({ SSL_CERT_FILE: '/custom/ca.pem', SSL_CERT_DIR: '/custom/certs',
    OPENAI_API_KEY: 'secret', PYTHONPATH: '/untrusted', SSLKEYLOGFILE: '/private' }, true);
  expect(env.SSL_CERT_FILE).toBe('/custom/ca.pem'); expect(env.SSL_CERT_DIR).toBe('/custom/certs');
  expect(env.OPENAI_API_KEY).toBeUndefined(); expect(env.PYTHONPATH).toBeUndefined(); expect(env.SSLKEYLOGFILE).toBeUndefined();
});
