import http from 'node:http';

const CHAT_TEXT = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 1_700_000_000,
  model: 'test-model',
  choices: [
    { index: 0, message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' },
  ],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
};

const CHAT_TOOL = {
  id: 'chatcmpl-tool',
  object: 'chat.completion',
  created: 1_700_000_000,
  model: 'test-model',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
          },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
};

const ANTHROPIC_TEXT = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'test-model',
  content: [{ type: 'text', text: 'hello' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 3, output_tokens: 2 },
};

const ANTHROPIC_TOOL = {
  id: 'msg_tool',
  type: 'message',
  role: 'assistant',
  model: 'test-model',
  content: [
    { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } },
  ],
  stop_reason: 'tool_use',
  stop_sequence: null,
  usage: { input_tokens: 3, output_tokens: 2 },
};

const RESPONSES_TEXT = {
  id: 'resp_1',
  object: 'response',
  created_at: 1_700_000_000,
  model: 'test-model',
  status: 'completed',
  output: [
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'hello' }],
    },
  ],
  usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
};

const RESPONSES_TOOL = {
  id: 'resp_tool',
  object: 'response',
  created_at: 1_700_000_000,
  model: 'test-model',
  status: 'completed',
  output: [
    {
      type: 'function_call',
      call_id: 'call_1',
      name: 'get_weather',
      arguments: '{"city":"Paris"}',
    },
  ],
  usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
};

function event(name, data) {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

const CHAT_STREAM = [
  `data: ${JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'hello' }, finish_reason: null }],
  })}\n\n`,
  `data: ${JSON.stringify({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 1_700_000_000,
    model: 'test-model',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  })}\n\n`,
  'data: [DONE]\n\n',
];

const ANTHROPIC_STREAM = [
  event('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'test-model',
      content: [],
      usage: { input_tokens: 3, output_tokens: 0 },
    },
  }),
  event('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  }),
  event('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'hello' },
  }),
  event('content_block_stop', { type: 'content_block_stop', index: 0 }),
  event('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 2 },
  }),
  event('message_stop', { type: 'message_stop' }),
];

const RESPONSES_STREAM = [
  event('response.created', {
    type: 'response.created',
    response: {
      id: 'resp_1',
      object: 'response',
      created_at: 1_700_000_000,
      model: 'test-model',
      status: 'in_progress',
      output: [],
      usage: { input_tokens: 0, output_tokens: 0 },
    },
    sequence_number: 0,
  }),
  event('response.output_item.added', {
    type: 'response.output_item.added',
    output_index: 0,
    item: { type: 'message', role: 'assistant', content: [] },
    sequence_number: 1,
  }),
  event('response.content_part.added', {
    type: 'response.content_part.added',
    output_index: 0,
    content_index: 0,
    part: { type: 'output_text', text: '' },
    sequence_number: 2,
  }),
  event('response.output_text.delta', {
    type: 'response.output_text.delta',
    output_index: 0,
    content_index: 0,
    delta: 'hello',
    sequence_number: 3,
  }),
  event('response.output_text.done', {
    type: 'response.output_text.done',
    output_index: 0,
    content_index: 0,
    text: 'hello',
    sequence_number: 4,
  }),
  event('response.output_item.done', {
    type: 'response.output_item.done',
    output_index: 0,
    item: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'hello' }],
    },
    sequence_number: 5,
  }),
  event('response.completed', {
    type: 'response.completed',
    response: RESPONSES_TEXT,
    sequence_number: 6,
  }),
];

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch {
        resolve({ raw: text });
      }
    });
    req.on('error', reject);
  });
}

function sendSse(res, frames) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
  });
  for (const frame of frames) res.write(frame);
  res.end();
}

export function createProtocolMock() {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    requests.push({ url: req.url, body });

    if (body.model === 'error-model') {
      const anthropic = req.url.startsWith('/v1/messages');
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify(
          anthropic
            ? { type: 'error', error: { type: 'invalid_request_error', message: 'boom' } }
            : { error: { message: 'boom', type: 'invalid_request_error', code: 'boom' } },
        ),
      );
      return;
    }

    const tool = body.model === 'tool-model';
    const stream = body.stream === true;

    if (req.url.startsWith('/v1/chat/completions')) {
      if (stream) sendSse(res, CHAT_STREAM);
      else sendJson(res, tool ? CHAT_TOOL : CHAT_TEXT);
      return;
    }
    if (req.url.startsWith('/v1/messages')) {
      if (stream) sendSse(res, ANTHROPIC_STREAM);
      else sendJson(res, tool ? ANTHROPIC_TOOL : ANTHROPIC_TEXT);
      return;
    }
    if (req.url.startsWith('/v1/responses')) {
      if (stream) sendSse(res, RESPONSES_STREAM);
      else sendJson(res, tool ? RESPONSES_TOOL : RESPONSES_TEXT);
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'not found' } }));
  });

  return {
    server,
    requests,
    async start() {
      await listen(server, 0);
      return server.address().port;
    },
    async close() {
      await closeServer(server);
    },
  };
}

function sendJson(res, payload) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

export function requestJson(port, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: body === undefined ? 'GET' : 'POST',
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': payload.length }
          : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            // SSE or plain text.
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export async function waitForHealth(port) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await requestJson(port, '/health');
      if (response.status === 200) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('gateway did not become healthy');
}

export async function findFreePort() {
  const server = http.createServer();
  const port = await listen(server, 0);
  await closeServer(server);
  return port;
}
