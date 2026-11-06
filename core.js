export function hostKind(host) {
    if (host?.kind === 'mobile' || ['android', 'ios', 'ohos'].includes(host?.platform)) return 'mobile';
    if (host?.kind === 'desktop' || ['windows', 'macos', 'linux'].includes(host?.platform)) return 'desktop';
    return 'unknown';
}

export function startupAllowed({ kind, enabled, serverId, previousPending, attempted }) {
    return kind === 'desktop' && enabled === true && Boolean(serverId) && !previousPending && !attempted;
}

export function makeOptions(rawCatalog, getSelection, status) {
    if (!Array.isArray(rawCatalog?.supported_dataset_ids) || !Array.isArray(rawCatalog?.default_dataset_ids)) {
        throw new Error('TT 同步数据目录不兼容，请使用原生同步面板。');
    }
    const selection = getSelection({
        policyVersion: rawCatalog.policy_version,
        supportedDatasetIds: rawCatalog.supported_dataset_ids,
        defaultDatasetIds: rawCatalog.default_dataset_ids,
    });
    if (!selection?.dataset_ids?.length) throw new Error('尚未选择同步内容。');
    if (!selection.dataset_ids.includes('extensions.store')) {
        throw new Error('当前范围缺少扩展存储（extensions.store）。请在原生同步面板勾选后再同步千千结记忆。');
    }
    if (!['exact', 'prefer-newer'].includes(status?.overwrite_policy)) {
        throw new Error('无法确认冲突处理策略，请先打开原生同步面板。');
    }
    return { selection, overwrite_policy: status.overwrite_policy, require_bundle_zstd: true };
}

export function completed(report) {
    return report?.result?.status === 'completed';
}
