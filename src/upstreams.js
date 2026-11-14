import fs from 'node:fs';
import { once } from 'node:events';
import { Agent } from 'undici';

const direct = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
const generative = new Set(['/v1/messages', '/v1/messages/count_tokens', '/v1/chat/completions', '/v1/responses']);
const retryStatus = new Set([401, 403, 404, 408, 429, 500, 502, 503, 504, 529]);

export function loadUpstreams(file = process.env.ANTIGRAVITY_UPSTREAMS_CONFIG) {
    if (!file) return [];
    const providers = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(providers)) throw new Error('Upstream configuration must be an array');
    for (const provider of providers) {
        if (!/^[a-z][a-z0-9-]*$/.test(provider.name) || !/^https?:$/.test(new URL(provider.url).protocol)) {
            throw new Error('Invalid upstream name or URL');
        }
    }
    return providers;
}

export function studioModel(model) {
    return model.replace(/^(gemini-.+)-(none|minimal|low|medium|high|xhigh|extra_high|max|auto)$/, '$1($2)');
}

export function nativeModel(model) {
    return model.replace(/^(gemini-.+)\((none|minimal|low|medium|high|xhigh|extra_high|max|auto)\)$/, '$1-$2');
}

function baseModel(model) { return studioModel(model).replace(/\([^()]+\)$/, ''); }

// Preserve all historical text and arguments while reducing the number of old
// native function-call frames. Recent batches and the current turn stay native.
export function transcribeOldTools(body, keep = 2) {
    const messages = body.messages;
    if (!Array.isArray(messages)) return body;
    const batches = [];
    let lastUserText = messages.length;
    for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        if (message.role === 'assistant' && Array.isArray(message.content) && message.content.some(b => b.type === 'tool_use')) batches.push(i);
        if (message.role === 'user' && (typeof message.content === 'string' || message.content?.some(b => b.type === 'text'))) lastUserText = i;
    }
    if (batches.length <= keep) return body;
    const cutoff = Math.min(batches[batches.length - keep], lastUserText);
    const old = new Set(messages.slice(0, cutoff).flatMap(m => Array.isArray(m.content) ? m.content.filter(b => b.type === 'tool_use').map(b => b.id) : []));
    return { ...body, messages: messages.map((message, index) => {
        if (!Array.isArray(message.content)) return message;
        return { ...message, content: message.content.flatMap(block => {
            if (block.type === 'tool_use' && old.has(block.id)) return [{ type: 'text', text: `[历史工具调用 ${block.id} ${block.name}] ${JSON.stringify(block.input)}` }];
            if (block.type === 'tool_result' && old.has(block.tool_use_id)) return [{ type: 'text', text: `[历史工具结果 ${block.tool_use_id}] ${typeof block.content === 'string' ? block.content : JSON.stringify(block.content)}` }];
            if (index < cutoff && ['thinking', 'redacted_thinking'].includes(block.type)) return block.thinking ? [{ type: 'text', text: block.thinking }] : [];
            return [block];
        }) };
    }) };
}

function retryError(text) {
    return /RESOURCE_EXHAUSTED|QUOTA_EXHAUSTED|rate_limit|overloaded|service_unavailable|capacity|UNAVAILABLE/i.test(text);
}

// Hold only the SSE preamble. Once any text/tool output is committed, never replay
// the request on another backend: tools may already have been executed by a client.
function streamDecision(text) {
    for (const frame of text.split(/\r?\n\r?\n/).slice(0, -1)) {
        const line = frame.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n');
        if (!line || line === '[DONE]') continue;
        let data;
        try { data = JSON.parse(line); } catch { continue; }
        if (data.type === 'error' || data.error) return retryError(line) ? 'retry' : 'commit';
        if (data.type === 'message_stop') return 'retry'; // no substantive block preceded it
        if (data.type === 'content_block_start' && data.content_block?.type === 'tool_use') return 'commit';
        if (data.type === 'content_block_delta' && (data.delta?.text || data.delta?.thinking || data.delta?.partial_json)) return 'commit';
        if (data.choices?.some(c => c.finish_reason || Object.values(c.delta || {}).some(v => v && v !== 'assistant'))) return 'commit';
        if (data.candidates?.length || /^response\.(output_|content_|function_|completed|failed)/.test(data.type || '')) return 'commit';
    }
    return null;
}

export function createUpstreams(providers = [], { fetchImpl = fetch, log = () => {} } = {}) {
    const cache = new Map();
    async function catalog(provider) {
        const old = cache.get(provider.name);
        if (old && Date.now() - old.at < 60_000) return old.models;
        try {
            const response = await fetchImpl(new URL('/v1/models', provider.url), {
                dispatcher: direct, signal: AbortSignal.timeout(10_000),
                headers: provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {},
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            if (!Array.isArray(data.data)) throw new Error('Invalid upstream catalog');
            cache.set(provider.name, { at: Date.now(), models: data.data });
            return data.data;
        } catch (error) {
            log(`[Upstream ${provider.name}] Catalog unavailable: ${error.message}`);
            return old?.models || [];
        }
    }

    async function mergeModels(native = []) {
        const models = new Map(native.map(m => [m.id, { ...m, source: 'antigravity' }]));
        const lists = await Promise.all(providers.map(catalog));
        for (let i = 0; i < providers.length; i++) {
            const provider = providers[i];
            for (const model of lists[i]) {
                models.set(`${provider.name}/${model.id}`, { ...model, id: `${provider.name}/${model.id}`, source: provider.name });
                if (provider.default && !models.has(model.id)) models.set(model.id, { ...model, source: provider.name });
            }
        }
        for (const [id, model] of models) {
            if (model.source !== 'antigravity') continue;
            const sources = providers.filter((p, i) => p.default && lists[i].some(m => m.id === baseModel(id) || m.id === id)).map(p => p.name);
            if (sources.length) models.set(id, { ...model, source: 'auto', sources: [...sources, 'antigravity'] });
        }
        return [...models.values()];
    }

    async function middleware(req, res, next) {
        if (!providers.length) return next();
        if (req.method === 'GET' && req.path === '/v1beta/models') {
            const list = await mergeModels();
            return res.json({ models: list.map(m => ({
                name: `models/${m.id}`, displayName: m.name || m.id, description: m.description || '',
                inputTokenLimit: m.input_token_limit, outputTokenLimit: m.output_token_limit,
                supportedGenerationMethods: m.supported_generation_methods || ['generateContent'],
                source: m.source,
            })) });
        }
        const gemini = req.path.match(/^\/v1beta\/models\/(.+):(generateContent|streamGenerateContent|countTokens)$/);
        if (req.method !== 'POST' || (!generative.has(req.path) && !gemini)) return next();
        const original = gemini ? decodeURIComponent(gemini[1]) : req.body?.model;
        if (typeof original !== 'string') return next();
        const slash = original.indexOf('/');
        const source = slash > 0 ? original.slice(0, slash) : null;
        const model = source ? original.slice(slash + 1) : original;
        if (source === 'antigravity') { req.body.model = nativeModel(model); res.setHeader('x-model-source', 'antigravity'); return next(); }
        if (source && !providers.some(p => p.name === source)) {
            return res.status(400).json({ error: { type: 'invalid_request_error', message: `Unknown model source: ${source}` } });
        }
        const controller = new AbortController();
        const disconnected = () => { if (!res.writableEnded) controller.abort(); };
        res.on('close', disconnected);
        let attempted = false;
        let lastFailure;
        try {
            for (const provider of providers) {
                if (source ? provider.name !== source : !provider.default) continue;
                const normalized = provider.modelStyle === 'studio' ? studioModel(model) : model;
                if (!source && !(await catalog(provider)).some(m => m.id === baseModel(normalized) || m.id === normalized)) continue;
                attempted = true;
                let body = gemini ? { ...req.body } : { ...req.body, model: normalized };
                if (req.path === '/v1/messages' && provider.historyToolBatches) body = transcribeOldTools(body, provider.historyToolBatches);
                if (req.path === '/v1/messages' && body.thinking?.type === 'enabled' && body.thinking.budget_tokens == null) {
                    body.thinking = { ...body.thinking, budget_tokens: Math.max(1024, (body.max_tokens || 16384) - 1) };
                }
                const target = gemini ? `/v1beta/models/${encodeURIComponent(normalized)}:${gemini[2]}` : req.path;
                const query = new URL(req.url, 'http://localhost').searchParams;
                query.delete('key');
                const headers = { 'content-type': 'application/json' };
                if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
                if (req.headers['anthropic-version']) headers['anthropic-version'] = req.headers['anthropic-version'];
                try {
                    const response = await fetchImpl(new URL(target + (query.size ? `?${query}` : ''), provider.url), {
                        method: 'POST', headers, body: JSON.stringify(body), dispatcher: direct, signal: controller.signal,
                    });
                    const sse = response.headers.get('content-type')?.includes('text/event-stream');
                    if (!response.ok) {
                        const text = await response.text();
                        lastFailure = { status: response.status, text, type: response.headers.get('content-type') };
                        if (!source && (retryStatus.has(response.status) || retryError(text))) {
                            log(`[Upstream ${provider.name}] HTTP ${response.status}; trying next source`);
                            continue;
                        }
                        res.setHeader('x-model-source', provider.name);
                        res.status(response.status).type(lastFailure.type || 'application/json').send(text);
                        return;
                    }
                    if (!sse) {
                        const text = await response.text();
                        let failure, empty = false;
                        try {
                            const result = JSON.parse(text);
                            failure = result.error;
                            empty = result.type === 'message' && Array.isArray(result.content) && !result.content.some(b => b.type === 'tool_use' || b.type === 'text' && b.text?.trim());
                        } catch { /* non-JSON response */ }
                        if (!source && (empty || failure && retryError(JSON.stringify(failure)))) {
                            lastFailure = { status: 503, text, type: 'application/json' };
                            continue;
                        }
                        res.setHeader('x-model-source', provider.name);
                        res.status(response.status).type(response.headers.get('content-type') || 'application/json').send(text);
                        return;
                    }
                    const reader = response.body.getReader();
                    const decoder = new TextDecoder();
                    let preamble = '';
                    const initialChunks = [];
                    let committed = false;
                    let retry = false;
                    try {
                        for (;;) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            if (!committed) {
                                initialChunks.push(value);
                                preamble += decoder.decode(value, { stream: true });
                                const decision = streamDecision(preamble);
                                if (decision === 'retry' && !source) { retry = true; break; }
                                if (!decision && preamble.length < 65536) continue;
                                res.status(200).set({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-model-source': provider.name });
                                committed = true;
                                if (!res.write(Buffer.concat(initialChunks))) await once(res, 'drain', { signal: controller.signal });
                                initialChunks.length = 0;
                            } else if (!res.write(value)) await once(res, 'drain', { signal: controller.signal });
                        }
                    } finally { await reader.cancel().catch(() => {}); }
                    if (retry) {
                        lastFailure = { status: 503, text: preamble, type: 'text/event-stream' };
                        log(`[Upstream ${provider.name}] Empty response or early capacity error; trying next source`);
                        continue;
                    }
                    if (!committed) res.status(200).set({ 'content-type': 'text/event-stream', 'x-model-source': provider.name }).write(Buffer.concat(initialChunks));
                    res.end();
                    return;
                } catch (error) {
                    if (controller.signal.aborted) return;
                    if (res.headersSent) { res.destroy(error); return; }
                    lastFailure = { status: 503, type: 'application/json', text: JSON.stringify({ error: { type: 'api_error', message: `Upstream ${provider.name} unavailable` } }) };
                    log(`[Upstream ${provider.name}] Connection failed: ${error.message}`);
                    if (source) break;
                }
            }
            if (attempted && (source || req.path !== '/v1/messages')) {
                res.status(lastFailure?.status || 503).type(lastFailure?.type || 'application/json').send(lastFailure?.text || JSON.stringify({ error: { message: 'No upstream available' } }));
                return;
            }
            // Native Antigravity handler is the final source for Anthropic messages.
            if (!source && req.path === '/v1/messages') { req.body.model = nativeModel(model); res.setHeader('x-model-source', 'antigravity'); }
            next();
        } finally { res.off('close', disconnected); }
    }
    return { middleware, mergeModels };
}
