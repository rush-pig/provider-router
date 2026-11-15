import assert from 'node:assert/strict';
import test from 'node:test';
import { validateProvider, publicProvider } from '../src/config.mjs';
import {
  getModelsEndpoint,
  isModelRegistered,
  joinUpstreamUrl,
  parseModelReference,
} from '../src/protocols.mjs';
import { idsFromPayload } from '../src/upstream.mjs';

test('model references split on the first slash only', () => {
  assert.deepEqual(parseModelReference('openai/gpt-4.1'), {
    provider: 'openai',
    model: 'gpt-4.1',
    raw: 'openai/gpt-4.1',
  });

  assert.deepEqual(parseModelReference('OpenRouter/anthropic/claude-sonnet-4.5'), {
    provider: 'openrouter',
    model: 'anthropic/claude-sonnet-4.5',
    raw: 'OpenRouter/anthropic/claude-sonnet-4.5',
  });

  assert.equal(parseModelReference('openai/'), null);
  assert.equal(parseModelReference('/gpt-4.1'), null);
  assert.equal(parseModelReference('gpt-4.1'), null);
  assert.equal(parseModelReference(''), null);
  assert.equal(parseModelReference(null), null);
});

test('upstream URL joining avoids duplicate version segments', () => {
  assert.equal(
    joinUpstreamUrl('https://api.openai.com/v1', '/v1/chat/completions').toString(),
    'https://api.openai.com/v1/chat/completions',
  );
  assert.equal(
    joinUpstreamUrl('https://openrouter.ai/api/v1', '/v1/chat/completions').toString(),
    'https://openrouter.ai/api/v1/chat/completions',
  );
  assert.equal(
    joinUpstreamUrl('https://generativelanguage.googleapis.com/v1beta', '/v1beta/models').toString(),
    'https://generativelanguage.googleapis.com/v1beta/models',
  );
  assert.equal(
    joinUpstreamUrl('http://127.0.0.1:11434', '/v1/chat/completions').toString(),
    'http://127.0.0.1:11434/v1/chat/completions',
  );
  assert.equal(
    joinUpstreamUrl('https://gateway.example.com/proxy/v1', '/v1/models').toString(),
    'https://gateway.example.com/proxy/v1/models',
  );
  assert.equal(
    joinUpstreamUrl('https://open.bigmodel.cn/api/paas/v4', '/v1/chat/completions').toString(),
    'https://open.bigmodel.cn/api/paas/v4/chat/completions',
  );
  assert.equal(
    joinUpstreamUrl('https://api.example.com/v1/chat/completions', '/v1/chat/completions').toString(),
    'https://api.example.com/v1/chat/completions',
  );
});

test('ollama model discovery uses api/tags', () => {
  const endpoint = getModelsEndpoint({
    baseUrl: 'http://127.0.0.1:11434/v1',
    protocol: 'ollama',
  });
  assert.equal(endpoint.toString(), 'http://127.0.0.1:11434/api/tags');
});

test('model payload parsing supports common provider shapes', () => {
  assert.deepEqual(
    idsFromPayload({ data: [{ id: 'gpt-4.1', name: 'GPT-4.1' }] }, 'openai'),
    [{ id: 'gpt-4.1', name: 'GPT-4.1' }],
  );
  assert.deepEqual(
    idsFromPayload(
      { models: [{ name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro' }] },
      'google',
    ),
    [{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }],
  );
  assert.deepEqual(
    idsFromPayload({ models: [{ name: 'qwen3:8b', model: 'qwen3:8b' }] }, 'ollama'),
    [{ id: 'qwen3:8b', name: 'qwen3:8b' }],
  );
  assert.deepEqual(idsFromPayload({}, 'openai'), []);
});

test('only registered models are routable', () => {
  const provider = { models: ['gpt-4.1', 'org/nested-model:v2'] };
  assert.equal(isModelRegistered(provider, 'gpt-4.1'), true);
  assert.equal(isModelRegistered(provider, 'org/nested-model:v2'), true);
  assert.equal(isModelRegistered(provider, 'gpt-4.1-mini'), false);
  assert.equal(isModelRegistered({ models: [] }, 'gpt-4.1'), false);
  assert.equal(isModelRegistered({}, 'gpt-4.1'), false);
});

test('provider validation normalizes and deduplicates configuration', () => {
  const provider = validateProvider({
    name: 'Demo.Provider',
    label: ' Demo ',
    baseUrl: 'https://example.com/v1/',
    protocol: 'openai',
    apiKey: '  secret-key  ',
    models: ['model/a', 'model/a', ' model/b ', ''],
    enabled: true,
  });

  assert.equal(provider.name, 'demo.provider');
  assert.equal(provider.label, 'Demo');
  assert.equal(provider.baseUrl, 'https://example.com/v1');
  assert.equal(provider.apiKey, 'secret-key');
  assert.deepEqual(provider.models, ['model/a', 'model/b']);
});

test('provider updates preserve the existing API key unless cleared', () => {
  const original = validateProvider({
    name: 'demo',
    label: 'Demo',
    baseUrl: 'https://example.com/v1',
    apiKey: 'secret',
    protocol: 'openai',
    models: ['model'],
  });
  const updated = validateProvider(
    {
      name: 'demo',
      label: 'Demo 2',
      baseUrl: 'https://example.com/v1',
      protocol: 'openai',
      models: ['model-2'],
    },
    { previous: original, existingNames: ['demo'] },
  );
  assert.equal(updated.apiKey, 'secret');

  const cleared = validateProvider(
    {
      name: 'demo',
      baseUrl: 'https://example.com/v1',
      protocol: 'openai',
      models: [],
      clearApiKey: true,
    },
    { previous: original, existingNames: ['demo'] },
  );
  assert.equal(cleared.apiKey, '');
});

test('public provider omits the API key', () => {
  const provider = validateProvider({
    name: 'demo',
    baseUrl: 'https://example.com/v1',
    apiKey: 'secret',
    protocol: 'openai',
    models: [],
  });
  const view = publicProvider(provider);
  assert.equal('apiKey' in view, false);
  assert.equal(view.hasApiKey, true);
  assert.equal(view.apiKeyHint.endsWith('cret'), true);
});
