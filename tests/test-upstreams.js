import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { createUpstreams, studioModel, nativeModel, transcribeOldTools } from '../src/upstreams.js';

const providers = [
    { name: 'aistudio', url: 'http://studio.local', default: true, modelStyle: 'studio' },
    { name: 'gemini-web', url: 'http://web.local', default: false },
];
const model = 'gemini-4-hydrogen';
const json = (data, status = 200) => Response.json(data, { status });
const sse = text => new Response(text, { headers: { 'content-type': 'text/event-stream' } });

async function fixture(t, behavior, upstreams = providers) {
    const calls = [];
    const api = createUpstreams(upstreams, { fetchImpl: async (url, options) => {
        url = new URL(url);
        if (url.pathname === '/v1/models') return json({ data: [{ id: model, object: 'model', input_token_limit: 1048576 }] });
        const body = JSON.parse(options.body);
        calls.push({ host: url.hostname, path: url.pathname, body, signal: options.signal, headers: options.headers });
        return behavior(url, body, calls.length);
    } });
    const app = express();
    app.use(express.json());
    app.use(api.middleware);
    app.post('/v1/messages', (req, res) => res.json({ native: true, model: req.body.model }));
    app.use((req, res) => res.status(404).json({ missing: true }));
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => { server.closeAllConnections(); server.close(); });
    const request = (body, path = '/v1/messages') => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { request, calls, api, base: `http://127.0.0.1:${server.address().port}` };
}

test('model suffixes preserve thinking level in both directions', () => {
    assert.equal(studioModel('gemini-4-hydrogen-high'), `${model}(high)`);
    assert.equal(nativeModel(`${model}(high)`), 'gemini-4-hydrogen-high');
});

test('implicit Gemini routes to Studio, preserving tools and adding required thinking budget', async t => {
    const f = await fixture(t, (_, body) => json({ model: body.model }));
    const response = await f.request({ model: `${model}-high`, tools: [{ name: 'query' }], thinking: { type: 'enabled' }, max_tokens: 16384 });
    assert.equal(response.headers.get('x-model-source'), 'aistudio');
    assert.equal((await response.json()).model, `${model}(high)`);
    assert.equal(f.calls[0].body.thinking.budget_tokens, 16383);
    assert.deepEqual(f.calls[0].body.tools, [{ name: 'query' }]);
});

test('Claude and explicit Antigravity use native handler', async t => {
    const f = await fixture(t, () => { throw new Error('Must not call external source'); });
    assert.equal((await (await f.request({ model: 'claude-sonnet-4-6' })).json()).native, true);
    assert.equal((await (await f.request({ model: `antigravity/${model}-high` })).json()).model, `${model}-high`);
    assert.equal(f.calls.length, 0);
});

test('quota error falls back to native with native model alias', async t => {
    const f = await fixture(t, () => json({ error: { message: 'RESOURCE_EXHAUSTED' } }, 429));
    const response = await f.request({ model: `${model}(high)` });
    assert.deepEqual(await response.json(), { native: true, model: `${model}-high` });
});

test('invalid input is returned without failover', async t => {
    const f = await fixture(t, () => json({ error: { message: 'Invalid schema' } }, 400));
    const response = await f.request({ model });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.message, 'Invalid schema');
});

test('explicit source selects Web and does not silently fall back', async t => {
    const f = await fixture(t, () => json({ error: { message: 'quota exhausted' } }, 429));
    const response = await f.request({ model: `gemini-web/${model}` });
    assert.equal(response.status, 429);
    assert.equal(f.calls[0].host, 'web.local');
    assert.equal(f.calls[0].body.model, model);
});

test('OpenAI requests stay in their original protocol', async t => {
    const f = await fixture(t, () => json({ choices: [{ message: { content: 'OK' } }] }));
    const response = await f.request({ model, messages: [{ role: 'user', content: 'hi' }] }, '/v1/chat/completions');
    assert.equal(response.status, 200);
    assert.equal(f.calls[0].path, '/v1/chat/completions');
});

test('Gemini REST path rewrites namespaced model and keeps generation config', async t => {
    const f = await fixture(t, () => json({ candidates: [] }));
    await f.request({ contents: [], generationConfig: { temperature: 0.3 } }, `/v1beta/models/aistudio/${model}:generateContent`);
    assert.equal(f.calls[0].path, `/v1beta/models/${model}:generateContent`);
    assert.equal(f.calls[0].body.generationConfig.temperature, 0.3);
});

test('model catalog merges sources without overwriting native IDs', async t => {
    const f = await fixture(t, () => json({}));
    const models = await f.api.mergeModels([{ id: model, native: true }]);
    assert.equal(models.find(m => m.id === model).native, true);
    assert.deepEqual(models.find(m => m.id === model).sources, ['aistudio', 'antigravity']);
    assert.ok(models.some(m => m.id === `aistudio/${model}`));
    assert.ok(models.some(m => m.id === `gemini-web/${model}`));
});

test('SSE capacity error before visible output falls back', async t => {
    const f = await fixture(t, () => sse('event: message_start\ndata: {"type":"message_start"}\n\nevent: error\ndata: {"type":"error","error":{"type":"rate_limit_error"}}\n\n'));
    const response = await f.request({ model, stream: true });
    assert.equal((await response.json()).native, true);
});

test('SSE error after tool start is relayed without replay', async t => {
    const text = 'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"tool_use","name":"query"}}\n\nevent: error\ndata: {"type":"error","error":{"type":"rate_limit_error"}}\n\n';
    const f = await fixture(t, () => sse(text));
    const response = await f.request({ model, stream: true });
    assert.equal(response.headers.get('x-model-source'), 'aistudio');
    assert.equal(await response.text(), text);
    assert.equal(f.calls.length, 1);
});

test('client disconnect aborts an outstanding upstream request', async t => {
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    const f = await fixture(t, (_, __, ___) => new Promise((resolve, reject) => {
        const signal = f.calls.at(-1).signal;
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        started();
    }));
    const abort = new AbortController();
    const pending = fetch(`${f.base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }), signal: abort.signal });
    await ready;
    abort.abort();
    await assert.rejects(pending);
    for (let i = 0; i < 20 && !f.calls[0].signal.aborted; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.calls[0].signal.aborted, true);
});

test('dedicated instances with no external config keep routing unchanged', async t => {
    const f = await fixture(t, () => { throw new Error('Must not contact upstream'); }, []);
    assert.equal((await (await f.request({ model: 'gemini-4-hydrogen-high' })).json()).native, true);
    assert.equal(f.calls.length, 0);
});

test('old tool transcripts preserve arguments/results and all current-turn native calls', () => {
    const pair = n => [
        { role: 'assistant', content: [{ type: 'tool_use', id: `c${n}`, name: 'query', input: { panel: `panel${n}` } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: `c${n}`, content: `结果${n}` }] },
    ];
    const body = { messages: [...pair(1), ...pair(2), ...pair(3), { role: 'user', content: '当前状态' }, ...pair(4), ...pair(5), ...pair(6)], tools: [{ name: 'query' }] };
    const original = JSON.stringify(body);
    const converted = transcribeOldTools(body, 2);
    assert.equal(JSON.stringify(body), original);
    assert.match(converted.messages[0].content[0].text, /query.*panel1/);
    assert.match(converted.messages[1].content[0].text, /结果1/);
    assert.equal(converted.messages[7].content[0].type, 'tool_use');
    assert.equal(converted.messages[11].content[0].type, 'tool_use');
    assert.deepEqual(converted.tools, body.tools);
});

test('empty signature-only SSE responses fall back instead of reporting success', async t => {
    const f = await fixture(t, () => sse('event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"thinking","thinking":""}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"signature_delta","signature":"sig"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'));
    assert.equal((await (await f.request({ model, stream: true })).json()).native, true);
});

test('empty nonstream Anthropic response falls back', async t => {
    const f = await fixture(t, () => json({ type: 'message', content: [{ type: 'thinking', thinking: '', signature: 'sig' }], stop_reason: 'end_turn' }));
    assert.equal((await (await f.request({ model })).json()).native, true);
});

test('UTF-8 characters split at the first SSE commit remain byte-exact', async t => {
    const text = 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你好"}}\n\n中文';
    const bytes = new TextEncoder().encode(text);
    const f = await fixture(t, () => new Response(new ReadableStream({ start(controller) {
        controller.enqueue(bytes.slice(0, bytes.length - 4));
        controller.enqueue(bytes.slice(bytes.length - 4)); controller.close();
    } }), { headers: { 'content-type': 'text/event-stream' } }));
    assert.equal(await (await f.request({ model, stream: true })).text(), text);
});

test('quota on Studio tries the next configured Web source before native', async t => {
    const f = await fixture(t, url => url.hostname === 'studio.local' ? json({ error: { message: 'quota' } }, 429) : json({ choices: [{ message: { content: 'OK' } }] }),
                            providers.map(p => ({ ...p, default: true })));
    const response = await f.request({ model });
    assert.equal(response.headers.get('x-model-source'), 'gemini-web');
    assert.deepEqual(f.calls.map(c => c.host), ['studio.local', 'web.local']);
});
