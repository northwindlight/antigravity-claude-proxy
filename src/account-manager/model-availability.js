/** Use a complete upstream catalog when available; unknown accounts stay eligible. */
export function accountSupportsModel(account, modelId) {
    if (!modelId || !account?.quota?.modelsComplete) return true;
    return Object.hasOwn(account.quota.models || {}, modelId);
}
