import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ANTIGRAVITY_ENDPOINT_FALLBACKS } from '../constants.js';
import { throttledFetch } from '../utils/helpers.js';
import { buildHeaders } from './request-builder.js';

const generateRoute = /^\/v1beta\/models\/(gemini-[a-z0-9.-]+):(generateContent|streamGenerateContent)$/;

function sendError(res, code, status, message) {
    res.status(code).json({ error: { code, status, message } });
}

async function* unwrapStream(body) {
    const lines = createInterface({ input: Readable.fromWeb(body), crlfDelay: Infinity });
    for await (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        const chunk = JSON.parse(data);
        if (chunk.error) throw new Error('Cloud Code returned a stream error');
        yield `data: ${JSON.stringify(chunk.response ?? chunk)}\n\n`;
    }
}

export function mountGeminiAPI(app, { accountManager, ensureInitialized, config, logger }) {
    app.post(generateRoute, async (req, res) => {
        const [, apiKey] = (req.get('authorization') || '').match(/^Bearer (.+)$/i) || [];
        if (config.apiKey && (apiKey || req.get('x-goog-api-key')) !== config.apiKey) {
            return sendError(res, 401, 'UNAUTHENTICATED', 'Invalid or missing API key');
        }

        const model = req.params[0];
        const operation = req.params[1];
        const streaming = operation === 'streamGenerateContent';
        if (!Array.isArray(req.body?.contents) || (streaming && req.query.alt !== 'sse')) {
            return sendError(res, 400, 'INVALID_ARGUMENT', 'Expected contents and alt=sse for streaming');
        }

        const controller = new AbortController();
        res.once('close', () => controller.abort());
        try {
            await ensureInitialized();
            const accounts = accountManager.getAllAccounts();
            const account = accounts[0];
            if (accounts.length !== 1 || account.enabled === false || account.isInvalid) {
                return sendError(res, 503, 'UNAVAILABLE', 'A dedicated Gemini account is required');
            }
            const token = await accountManager.getTokenForAccount(account);
            const project = await accountManager.getProjectForAccount(account, token);
            const payload = JSON.stringify({ project, model, request: req.body,
                userAgent: 'antigravity', requestType: 'agent', requestId: `agent-${randomUUID()}` });
            const accept = streaming ? 'text/event-stream' : 'application/json';
            let failure;
            for (const endpoint of ANTIGRAVITY_ENDPOINT_FALLBACKS) {
                const upstream = await throttledFetch(`${endpoint}/v1internal:${operation}${streaming ? '?alt=sse' : ''}`, {
                    method: 'POST', headers: buildHeaders(token, model, accept), body: payload, signal: controller.signal
                });
                if (!upstream.ok) {
                    const error = (await upstream.json().catch(() => null))?.error;
                    // Keep quota errors if another endpoint only reports that the model was not found.
                    if (!failure || upstream.status !== 404) failure = { code: upstream.status, error };
                    if (![404, 429].includes(upstream.status) && upstream.status < 500) break;
                    continue;
                }

                if (!streaming) {
                    const data = await upstream.json();
                    return res.json(data.response ?? data);
                }
                if (!upstream.body || !upstream.headers.get('content-type')?.includes('text/event-stream')) {
                    throw new Error('Cloud Code did not return an SSE stream');
                }
                res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
                await pipeline(Readable.from(unwrapStream(upstream.body)), res, { signal: controller.signal });
                return;
            }
            const { code, error } = failure;
            return sendError(res, code, error?.status ?? 'UNKNOWN', error?.message ?? 'Cloud Code request failed');
        } catch (error) {
            if (controller.signal.aborted) return;
            logger.warn('[Gemini API] Cloud Code request failed:', error.name);
            if (res.headersSent) res.destroy();
            else sendError(res, 502, 'UNAVAILABLE', 'Cloud Code request failed');
        }
    });
}
