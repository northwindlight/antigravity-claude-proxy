const { test } = require('node:test');
const assert = require('node:assert/strict');

const hydrogen = 'gemini-4-hydrogen-high';
const common = 'gemini-3.8-flash-high';
const claude = 'claude-sonnet-4-6';
const modules = Promise.all([
    import('../src/account-manager/strategies/index.js'),
    import('../src/account-manager/rate-limits.js'),
    import('../src/account-manager/model-availability.js')
]);
function accounts() {
    return [
        { email: 'old@example.com', enabled: true, quota: { modelsComplete: true, lastChecked: Date.now(), models: { [hydrogen]: { remainingFraction: 1 }, [common]: { remainingFraction: 1 } } } },
        { email: 'new@example.com', enabled: true, quota: { modelsComplete: true, lastChecked: Date.now(), models: { [claude]: { remainingFraction: 1 }, [common]: { remainingFraction: 1 } } } }
    ];
}

for (const name of ['hybrid', 'sticky', 'round-robin']) {
    test(`${name}: routes exclusive models and shares common models`, async () => {
        const [{ createStrategy }, { getAvailableAccounts }] = await modules;
        const pool = accounts();
        const strategy = createStrategy(name);
        assert.equal(strategy.selectAccount(pool, hydrogen, { currentIndex: 1 }).account.email, pool[0].email);
        assert.equal(strategy.selectAccount(pool, claude, { currentIndex: 0 }).account.email, pool[1].email);
        assert.equal(getAvailableAccounts(pool, common).length, 2);
        assert.equal(strategy.selectAccount(pool, 'missing-model').account, null);
    });
}

test('hybrid fallback cannot route to unsupported account when capable account is limited', async () => {
    const [{ createStrategy }, rates] = await modules;
    const pool = accounts();
    pool[0].modelRateLimits = { [hydrogen]: { isRateLimited: true, resetTime: Date.now() + 60000 } };
    assert.equal(createStrategy('hybrid').selectAccount(pool, hydrogen).account, null);
    assert.equal(rates.getAvailableAccounts(pool, hydrogen).length, 0);
    assert.equal(rates.isAllRateLimited(pool, hydrogen), true);
    assert.ok(rates.getMinWaitTimeMs(pool, hydrogen) > 59000);
    assert.equal(rates.isAllRateLimited(pool, 'missing-model'), false);
});

test('hybrid emergency and token fallbacks preserve model access', async () => {
    const [{ createStrategy }] = await modules;
    for (const tokenCount of [50, 0]) {
        const pool = accounts();
        const strategy = createStrategy('hybrid', { tokenBucket: { initialTokens: tokenCount } });
        for (let i = 0; i < 10; i++) strategy.onFailure(pool[0]);
        if (tokenCount === 0) {
            while (strategy.getTokenBucketTracker().hasTokens(pool[0].email)) {
                strategy.getTokenBucketTracker().consume(pool[0].email);
            }
        }
        assert.equal(strategy.selectAccount(pool, hydrogen).account.email, pool[0].email);
    }
});

test('sticky does not wait for a model absent from every account', async () => {
    const [{ createStrategy }] = await modules;
    const pool = accounts();
    pool[0].modelRateLimits = { missing: { isRateLimited: true, resetTime: Date.now() + 60000 } };
    const result = createStrategy('sticky').selectAccount(pool, 'missing');
    assert.equal(result.account, null);
    assert.equal(result.waitMs, 0);
});

test('legacy and unknown catalogs remain eligible, complete empty catalog does not', async () => {
    const [, , { accountSupportsModel }] = await modules;
    assert.equal(accountSupportsModel({}, hydrogen), true);
    assert.equal(accountSupportsModel({ quota: { models: {} } }, hydrogen), true);
    assert.equal(accountSupportsModel({ quota: { modelsComplete: true, models: {} } }, hydrogen), false);
    assert.equal(accountSupportsModel(accounts()[0], null), true);
});
