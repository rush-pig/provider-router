import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createProtocolMock,
  findFreePort,
  requestJson,
  waitForHealth,
} from './support/protocol-mock.mjs';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODELS = ['test-model', 'tool-model', 'error-model'];

let mock;
let gateway;
let tempDir;
let gatewayPort;

before(async () => {
  mock = createProtocolMock();
  const mockPort = await mock.start();
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-router-test-'));
  const configPath = path.join(tempDir, 'config.json');
  const baseUrl = `http://127.0.0.1:${mockPort}/v1`;

  await fs.writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      providers: [
        { name: 'chat', baseUrl, protocol: 'openai', models: MODELS, enabled: true },
        { name: 'anthropic', baseUrl, protocol: 'anthropic', models: MODELS, enabled: true },
        {
          name: 'responses',
          baseUrl,
          protocol: 'openai-responses',
          models: MODELS,
          enabled: true,
        },
      ],
    }),
    { mode: 0o600 },
  );

  gatewayPort = await findFreePort();
  gateway = spawn(
    process.execPath,
    [
      'src/server.mjs',
      '--config',
      configPath,
      '--port',
      String(gatewayPort),
      '--no-open',
      '--silent',
    ],
    { cwd: PROJECT, stdio: 'ignore' },
  );
  await waitForHealth(gatewayPort);
});

after(async () => {
  gateway?.kill('SIGTERM');
  await mock?.close();
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

function resetRequests() {
  mock.requests.length = 0;
}

function lastRequest() {
  return mock.requests.at(-1);
}

async function post(pathname, body) {
  return requestJson(gatewayPort, pathname, body);
}

const directions = [
  {
    name: 'chat client -> anthropic provider',
    pathname: '/v1/chat/completions',
    body: { model: 'anthropic/test-model', messages: [{ role: 'user', content: 'hi' }] },
    upstream: '/v1/messages',
    check: (response) => {
      assert.equal(response.status, 200);
      assert.equal(response.json?.object, 'chat.completion');
      assert.equal(response.json.choices[0].message.content, 'hello');
    },
  },
  {
    name: 'anthropic client -> chat provider',
    pathname: '/v1/messages',
    body: {
      model: 'chat/test-model',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    },
    upstream: '/v1/chat/completions',
    check: (response) => {
      assert.equal(response.status, 200);
      assert.equal(response.json?.type, 'message');
      assert.equal(response.json.content[0].text, 'hello');
    },
  },
  {
    name: 'chat client -> responses provider',
    pathname: '/v1/chat/completions',
    body: { model: 'responses/test-model', messages: [{ role: 'user', content: 'hi' }] },
    upstream: '/v1/responses',
    check: (response) => {
      assert.equal(response.status, 200);
      assert.equal(response.json?.object, 'chat.completion');
    },
  },
  {
    name: 'responses client -> chat provider',
    pathname: '/v1/responses',
    body: { model: 'chat/test-model', input: 'hi' },
    upstream: '/v1/chat/completions',
    check: (response) => {
      assert.equal(response.status, 200);
      assert.equal(response.json?.object, 'response');
    },
  },
  {
    name: 'anthropic client -> responses provider',
    pathname: '/v1/messages',
    body: {
      model: 'responses/test-model',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    },
    upstream: '/v1/responses',
    check: (response) => {
      assert.equal(response.status, 200);
      assert.equal(response.json?.type, 'message');
    },
  },
  {
    name: 'responses client -> anthropic provider',
    pathname: '/v1/responses',
    body: { model: 'anthropic/test-model', input: 'hi' },
    upstream: '/v1/messages',
    check: (response) => {
      assert.equal(response.status, 200);
      assert.equal(response.json?.object, 'response');
    },
  },
];

for (const direction of directions) {
  test(direction.name, async () => {
    resetRequests();
    const response = await post(direction.pathname, direction.body);
    direction.check(response);
    assert.ok(lastRequest().url.startsWith(direction.upstream));
  });
}

test('streaming chat client -> anthropic provider', async () => {
  resetRequests();
  const response = await post('/v1/chat/completions', {
    model: 'anthropic/test-model',
    stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(response.status, 200);
  assert.match(response.text, /chat\.completion\.chunk/);
  assert.match(response.text, /content":"hello"/);
  assert.match(response.text, /\[DONE\]/);
});

test('streaming anthropic client -> chat provider', async () => {
  resetRequests();
  const response = await post('/v1/messages', {
    model: 'chat/test-model',
    stream: true,
    max_tokens: 100,
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(response.status, 200);
  assert.match(response.text, /message_start/);
  assert.match(response.text, /content_block_delta/);
});

test('streaming responses client -> chat provider', async () => {
  resetRequests();
  const response = await post('/v1/responses', {
    model: 'chat/test-model',
    stream: true,
    input: 'hi',
  });
  assert.equal(response.status, 200);
  assert.match(response.text, /response\.created/);
  assert.match(response.text, /response\.completed/);
});

test('error body follows the chat client protocol', async () => {
  const response = await post('/v1/chat/completions', {
    model: 'anthropic/error-model',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(response.status, 400);
  assert.equal(response.json?.error?.message, 'boom');
});

test('error body follows the anthropic client protocol', async () => {
  const response = await post('/v1/messages', {
    model: 'chat/error-model',
    max_tokens: 100,
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(response.status, 400);
  assert.equal(response.json?.type, 'error');
  assert.equal(response.json?.error?.message, 'boom');
});

test('same protocol keeps the path and unknown fields', async () => {
  resetRequests();
  const response = await post('/v1/chat/completions', {
    model: 'chat/test-model',
    messages: [{ role: 'user', content: 'hi' }],
    custom_field: { keep: true },
  });
  assert.equal(response.status, 200);
  assert.ok(lastRequest().url.startsWith('/v1/chat/completions'));
  assert.equal(lastRequest().body.model, 'test-model');
  assert.deepEqual(lastRequest().body.custom_field, { keep: true });
});

test('chat tool calls are converted to anthropic tool_use and back', async () => {
  resetRequests();
  const response = await post('/v1/chat/completions', {
    model: 'anthropic/tool-model',
    messages: [{ role: 'user', content: 'weather?' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      },
    ],
    tool_choice: 'auto',
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.choices[0].message.tool_calls[0].function.name, 'get_weather');
  assert.equal(lastRequest().url.startsWith('/v1/messages'), true);
  assert.equal(lastRequest().body.tools[0].name, 'get_weather');
});

test('anthropic tool calls are converted to chat tool_calls and back', async () => {
  resetRequests();
  const response = await post('/v1/messages', {
    model: 'chat/tool-model',
    max_tokens: 100,
    messages: [{ role: 'user', content: 'weather?' }],
    tools: [
      {
        name: 'get_weather',
        input_schema: { type: 'object', properties: { city: { type: 'string' } } },
      },
    ],
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.content[0].type, 'tool_use');
  assert.equal(response.json.content[0].name, 'get_weather');
  assert.equal(lastRequest().url.startsWith('/v1/chat/completions'), true);
  assert.equal(lastRequest().body.tools[0].function.name, 'get_weather');
});

test('responses tool calls are converted to chat tool_calls and back', async () => {
  resetRequests();
  const response = await post('/v1/responses', {
    model: 'chat/tool-model',
    input: 'weather?',
    tools: [
      {
        type: 'function',
        name: 'get_weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    ],
  });
  assert.equal(response.status, 200);
  assert.equal(response.json.output[0].type, 'function_call');
  assert.equal(response.json.output[0].name, 'get_weather');
  assert.equal(lastRequest().url.startsWith('/v1/chat/completions'), true);
});

test('anthropic cache breakpoints are injected when converting to anthropic', async () => {
  resetRequests();
  const response = await post('/v1/chat/completions', {
    model: 'anthropic/test-model',
    messages: [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
    ],
    tools: [
      {
        type: 'function',
        function: { name: 'get_weather', parameters: { type: 'object', properties: {} } },
      },
    ],
  });
  assert.equal(response.status, 200);
  const serialized = JSON.stringify(lastRequest().body);
  assert.match(serialized, /"cache_control"/);
});

test('anthropic billing header is stripped before sending to chat', async () => {
  resetRequests();
  const response = await post('/v1/messages', {
    model: 'chat/test-model',
    max_tokens: 100,
    system: 'x-anthropic-billing-header: cch=abc\nYou are helpful',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(response.status, 200);
  const serialized = JSON.stringify(lastRequest().body);
  assert.doesNotMatch(serialized, /x-anthropic-billing-header/);
  assert.match(serialized, /You are helpful/);
});

test('count_tokens rejects cross protocol conversion', async () => {
  const response = await post('/v1/messages/count_tokens', {
    model: 'chat/test-model',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(response.status, 400);
  assert.equal(response.json?.error?.code, 'conversion_unsupported_endpoint');
});
