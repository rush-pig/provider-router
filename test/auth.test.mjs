import assert from 'node:assert/strict';
import test from 'node:test';
import { applyProviderAuth, resolveAuthStyle } from '../src/auth.mjs';
import { publicProvider, validateProvider } from '../src/config.mjs';

function provider(overrides) {
  return {
    name: 'demo',
    protocol: 'openai',
    authStyle: 'auto',
    apiKey: 'secret-key',
    ...overrides,
  };
}

test('auth headers follow the protocol by default', () => {
  const openai = applyProviderAuth(new Headers(), provider({ protocol: 'openai' }));
  assert.equal(openai.get('authorization'), 'Bearer secret-key');
  assert.equal(openai.has('api-key'), false);

  const anthropic = applyProviderAuth(
    new Headers(),
    provider({ protocol: 'anthropic' }),
  );
  assert.equal(anthropic.get('x-api-key'), 'secret-key');
  assert.equal(anthropic.get('anthropic-version'), '2023-06-01');
  assert.equal(anthropic.has('authorization'), false);

  const google = applyProviderAuth(new Headers(), provider({ protocol: 'google' }));
  assert.equal(google.get('x-goog-api-key'), 'secret-key');
  assert.equal(google.has('authorization'), false);
});

test('client auth headers are dropped before the provider key is applied', () => {
  const headers = new Headers({
    authorization: 'Bearer client-owned-key',
    'api-key': 'client-owned-key',
    'x-api-key': 'client-owned-key',
    'x-goog-api-key': 'client-owned-key',
    'x-trace-id': 'keep-me',
  });

  applyProviderAuth(headers, provider({ protocol: 'openai' }));

  assert.equal(headers.get('authorization'), 'Bearer secret-key');
  assert.equal(headers.has('api-key'), false);
  assert.equal(headers.has('x-api-key'), false);
  assert.equal(headers.has('x-goog-api-key'), false);
  assert.equal(headers.get('x-trace-id'), 'keep-me');
});

test('explicit authStyle overrides the protocol default', () => {
  const azure = applyProviderAuth(
    new Headers(),
    provider({ protocol: 'custom', authStyle: 'api-key' }),
  );
  assert.equal(azure.get('api-key'), 'secret-key');
  assert.equal(azure.has('authorization'), false);

  const none = applyProviderAuth(
    new Headers(),
    provider({ protocol: 'openai', authStyle: 'none' }),
  );
  assert.equal(none.has('authorization'), false);
  assert.equal(none.has('api-key'), false);
});

test('providers without a key send no auth header', () => {
  const headers = applyProviderAuth(
    new Headers({ authorization: 'Bearer client-key' }),
    provider({ apiKey: '' }),
  );
  assert.equal(headers.has('authorization'), false);

  const anthropic = applyProviderAuth(
    new Headers(),
    provider({ protocol: 'anthropic', apiKey: '' }),
  );
  assert.equal(anthropic.get('anthropic-version'), '2023-06-01');
  assert.equal(anthropic.has('x-api-key'), false);
});

test('caller supplied anthropic-version is preserved', () => {
  const headers = applyProviderAuth(
    new Headers({ 'anthropic-version': '2024-01-01' }),
    provider({ protocol: 'anthropic' }),
  );
  assert.equal(headers.get('anthropic-version'), '2024-01-01');
});

test('auth style validation and resolution', () => {
  const auto = validateProvider({
    name: 'demo',
    baseUrl: 'https://example.com/v1',
    protocol: 'anthropic',
    apiKey: 'secret',
  });
  assert.equal(auto.authStyle, 'auto');
  assert.equal(resolveAuthStyle(auto), 'x-api-key');
  assert.equal(publicProvider(auto).effectiveAuthStyle, 'x-api-key');

  assert.throws(
    () =>
      validateProvider({
        name: 'demo',
        baseUrl: 'https://example.com/v1',
        protocol: 'openai',
        authStyle: 'basic',
      }),
    /不支持的鉴权方式/,
  );
});
