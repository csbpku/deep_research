import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SITE_RULES_KEY,
  SITE_RULE_MODES,
  describeSiteRule,
  normalizeHost,
  normalizeSiteRules,
  setSiteRule,
  siteRuleFor,
} from './site-rules.js';

test('the storage key and modes stay stable for the settings surface', () => {
  assert.equal(SITE_RULES_KEY, 'readerSiteRules');
  assert.deepEqual([...SITE_RULE_MODES], ['always', 'never', 'ask']);
  assert.ok(Object.isFrozen(SITE_RULE_MODES));
});

test('normalizeHost keeps only the lower-case hostname', () => {
  assert.equal(normalizeHost('https://Example.COM:8443/a?b=1#c'), 'example.com');
  assert.equal(normalizeHost('  https://example.com  '), 'example.com');
  // A trailing dot is the FQDN form of the same host.
  assert.equal(normalizeHost('https://example.com./path'), 'example.com');
  // Bare hosts, ports and paths.
  assert.equal(normalizeHost('Example.COM:8443'), 'example.com');
  assert.equal(normalizeHost('example.com/path?x=1'), 'example.com');
  assert.equal(normalizeHost('//Example.com/path'), 'example.com');
  assert.equal(normalizeHost('localhost:3000'), 'localhost');
  assert.equal(normalizeHost('127.0.0.1:8080'), '127.0.0.1');
  assert.equal(normalizeHost('https://[::1]:8443/x'), '[::1]');
  assert.equal(normalizeHost('https://user:pass@example.com/x'), 'example.com');
  // The URL parser punycodes IDN input; rules then hold the ASCII form.
  assert.equal(normalizeHost('https://例子.测试/'), 'xn--fsqu00a.xn--0zwm56d');
  // normalizeHost itself is faithful: www folding is a rule-matching concern.
  assert.equal(normalizeHost('www.example.com'), 'www.example.com');
});

test('normalizeHost rejects values that are not a web host', () => {
  const invalid = [
    '',
    '   ',
    null,
    undefined,
    42,
    {},
    [],
    'not a host',
    'exa_mple.com',
    'example..com',
    '-example.com',
    'example-.com',
    'example.com:abc',
    'example.com:99999',
    'https://',
    'https:/example.com',
    '*.example.com',
    'chrome://settings',
    'file:///tmp/article.html',
    'ftp://example.com/file',
    'mailto:someone@example.com',
    'javascript:alert(1)',
    'about:blank',
    'view-source:https://example.com',
  ];
  for (const value of invalid) {
    assert.equal(normalizeHost(value), '', `expected ${String(value)} to be rejected`);
  }
});

const alwaysExample = { 'example.com': 'always' };

test('an exact rule applies to the bare and the www host', () => {
  assert.deepEqual(siteRuleFor('https://example.com/a', alwaysExample), {
    host: 'example.com',
    mode: 'always',
    matched: 'exact',
  });
  assert.deepEqual(siteRuleFor('https://www.example.com/a', alwaysExample), {
    host: 'www.example.com',
    mode: 'always',
    matched: 'exact',
  });
  // Folding is symmetric: a rule stored for www also covers the bare host.
  assert.deepEqual(siteRuleFor('http://example.com/', { 'www.example.com': 'never' }), {
    host: 'example.com',
    mode: 'never',
    matched: 'exact',
  });
});

test('a wildcard covers subdomains but not its own base domain', () => {
  const rules = { '*.example.com': 'never' };
  assert.equal(siteRuleFor('https://a.example.com/doc', rules).mode, 'never');
  assert.equal(siteRuleFor('https://a.example.com/doc', rules).matched, 'suffix');
  assert.equal(siteRuleFor('https://b.a.example.com/doc', rules).mode, 'never');
  // www is a subdomain, so the wildcard covers it.
  assert.equal(siteRuleFor('https://www.example.com/doc', rules).mode, 'never');

  const base = siteRuleFor('https://example.com/doc', rules);
  assert.deepEqual(base, { host: 'example.com', mode: 'ask', matched: 'default' });
  // A suffix match must end on a label boundary.
  assert.equal(siteRuleFor('https://notexample.com/doc', rules).mode, 'ask');
});

test('exact rules win over wildcards and the longest wildcard wins', () => {
  const both = { '*.example.com': 'never', 'example.com': 'always' };
  assert.equal(siteRuleFor('https://example.com', both).mode, 'always');
  assert.equal(siteRuleFor('https://example.com', both).matched, 'exact');
  assert.equal(siteRuleFor('https://a.example.com', both).mode, 'never');
  assert.equal(siteRuleFor('https://a.example.com', both).matched, 'suffix');

  const nested = { '*.example.com': 'never', '*.a.example.com': 'always' };
  assert.equal(siteRuleFor('https://b.a.example.com', nested).mode, 'always');
  assert.equal(siteRuleFor('https://b.example.com', nested).mode, 'never');
});

test('non-web URLs and empty values always fall back to ask', () => {
  const rules = { 'example.com': 'always' };
  const urls = [
    'chrome://settings',
    'chrome-extension://abcdef/page.html',
    'file:///tmp/article.html',
    'ftp://example.com/doc',
    'about:blank',
    'javascript:void(0)',
    '',
    '   ',
    'not a url',
    'https://exa_mple.com/doc',
    null,
    undefined,
    42,
  ];
  for (const url of urls) {
    assert.deepEqual(siteRuleFor(url, rules), { host: '', mode: 'ask', matched: 'default' });
  }
});

test('a URL object or location-like value is accepted', () => {
  assert.deepEqual(siteRuleFor(new URL('https://www.example.com/a'), alwaysExample), {
    host: 'www.example.com',
    mode: 'always',
    matched: 'exact',
  });
  assert.equal(siteRuleFor({ href: 'https://example.com/a' }, alwaysExample).mode, 'always');
  assert.deepEqual(siteRuleFor({ get href() { throw new Error('hostile'); } }, alwaysExample), {
    host: '',
    mode: 'ask',
    matched: 'default',
  });
});

test('normalizeSiteRules cleans objects, arrays and junk input', () => {
  const input = { 'Example.COM': 'always' };
  assert.deepEqual(normalizeSiteRules(input), { 'example.com': 'always' });
  assert.deepEqual(input, { 'Example.COM': 'always' });

  assert.deepEqual(normalizeSiteRules(null), {});
  assert.deepEqual(normalizeSiteRules(undefined), {});
  assert.deepEqual(normalizeSiteRules('nope'), {});
  assert.deepEqual(normalizeSiteRules(42), {});
  assert.deepEqual(normalizeSiteRules([]), {});

  assert.deepEqual(
    normalizeSiteRules({
      ' Example.COM ': ' ALWAYS ',
      '*.foo.com': 'never',
      'example.org': 'sometimes',
      'ask.example.net': 'ask',
      'www.example.edu': 'never',
      'bad host': 'always',
    }),
    {
      'example.com': 'always',
      '*.foo.com': 'never',
      'example.edu': 'never',
    },
  );

  assert.deepEqual(
    normalizeSiteRules([
      ['example.com', 'always'],
      { host: 'example.net', mode: 'never' },
      ['bad host', 'always'],
      ['example.com', 'never'],
      null,
      'example.io => always',
    ]),
    { 'example.com': 'never', 'example.net': 'never' },
  );
});

test('normalizeSiteRules gives later entries precedence and caps at 500', () => {
  assert.deepEqual(normalizeSiteRules([['example.com', 'always'], ['example.com', 'never']]), {
    'example.com': 'never',
  });

  const many = Array.from({ length: 600 }, (_, index) => [`host${index}.example.com`, 'always']);
  const rules = normalizeSiteRules(many);
  assert.equal(Object.keys(rules).length, 500);
  assert.equal(rules['host0.example.com'], 'always');
  assert.equal(rules['host499.example.com'], 'always');
  assert.equal(rules['host500.example.com'], undefined);
});

test('prototype-pollution keys are dropped without touching Object.prototype', () => {
  const dangerous = JSON.parse(
    '{"__proto__":{"polluted":true},"constructor":"always","prototype":"never","example.com":"always"}',
  );
  const rules = normalizeSiteRules(dangerous);
  assert.deepEqual(rules, { 'example.com': 'always' });
  assert.equal(Object.getPrototypeOf(rules), Object.prototype);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);

  // A plain literal cannot create an own `__proto__` key, so use defineProperty
  // to simulate storage that was tampered with.
  const hostile = { 'example.com': 'always' };
  Object.defineProperty(hostile, '__proto__', {
    enumerable: true,
    configurable: true,
    value: { polluted: true },
  });
  assert.deepEqual(normalizeSiteRules(hostile), { 'example.com': 'always' });
  assert.equal({}.polluted, undefined);
});

test('a throwing getter only discards its own entry', () => {
  const hostile = { 'example.com': 'always' };
  Object.defineProperty(hostile, 'boom.example', {
    enumerable: true,
    get() {
      throw new Error('boom');
    },
  });
  assert.deepEqual(normalizeSiteRules(hostile), { 'example.com': 'always' });
});

test('setSiteRule returns a new map and never mutates its input', () => {
  const original = { 'example.com': 'always' };
  const next = setSiteRule(original, 'www.Example.org', 'never');
  assert.deepEqual(original, { 'example.com': 'always' });
  assert.notEqual(next, original);
  assert.deepEqual(next, { 'example.com': 'always', 'example.org': 'never' });

  const asked = setSiteRule(next, 'example.org', 'ask');
  assert.notEqual(asked, next);
  assert.deepEqual(asked, { 'example.com': 'always' });
  assert.deepEqual(next, { 'example.com': 'always', 'example.org': 'never' });

  assert.deepEqual(setSiteRule(original, 'example.com', 'ask'), {});
  assert.deepEqual(original, { 'example.com': 'always' });
});

test('setSiteRule accepts wildcard keys and ignores unusable input', () => {
  assert.deepEqual(setSiteRule({}, '*.Example.COM', 'never'), { '*.example.com': 'never' });
  assert.deepEqual(setSiteRule({}, 'example.com', 'NEVER'), { 'example.com': 'never' });

  const original = { 'example.com': 'always' };
  assert.deepEqual(setSiteRule(original, 'bad host', 'never'), original);
  assert.deepEqual(setSiteRule(original, '', 'never'), original);
  assert.deepEqual(setSiteRule(original, 'example.net', 'sometimes'), original);
  assert.deepEqual(setSiteRule({}, 'constructor', 'always'), {});
});

test('describeSiteRule is a stable, non-localized descriptor', () => {
  for (const mode of SITE_RULE_MODES) {
    const descriptor = describeSiteRule(mode);
    assert.equal(descriptor.mode, mode);
    assert.equal(describeSiteRule(mode), descriptor);
    assert.ok(Object.isFrozen(descriptor));
    assert.equal(typeof descriptor.label, 'string');
    assert.ok(descriptor.label.length > 0);
    // Localization belongs to the panel; this module must not ship Chinese copy.
    assert.doesNotMatch(descriptor.label, /[\u3400-\u9fff]/u);
    assert.doesNotMatch(descriptor.description, /[\u3400-\u9fff]/u);
  }

  assert.equal(describeSiteRule(' NEVER ').mode, 'never');
  assert.equal(describeSiteRule('bogus').mode, 'ask');
  assert.equal(describeSiteRule(undefined).mode, 'ask');
  assert.equal(describeSiteRule(null).mode, 'ask');
  assert.notEqual(describeSiteRule('always').label, describeSiteRule('never').label);
  assert.notEqual(describeSiteRule('always').label, describeSiteRule('ask').label);
});
