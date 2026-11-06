import { hostKind, startupAllowed, makeOptions, completed } from './core.js';

const KEY = 'tt-nas-sync-helper:v1';
const ATTEMPT = `${KEY}:startup-attempted`;
const ROOT = 'tt-nas-sync-helper';
const base = '/scripts/tauri/setting/setting-panel/';
let config;
try { config = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { config = {}; }
if (!config || typeof config !== 'object' || Array.isArray(config)) config = {};
const previousPending = config.pending === true;
let busy = false;
let api;
let statusNode;
let root;
let selected;
let lastUploadThisSession = 0;
const save = () => localStorage.setItem(KEY, JSON.stringify(config));
const status = text => { if (statusNode) statusNode.textContent = text; };
const stamp = time => time ? new Date(time).toLocaleString() : '尚未通过本插件上传';

function button(text, action, parent = root) {
    const node = document.createElement('button');
    node.type = 'button'; node.className = 'menu_button'; node.textContent = text;
    node.addEventListener('click', () => void Promise.resolve().then(action).catch(error => status(String(error?.message || error))));
    parent.append(node); return node;
}

function choose(message, choices) {
    return new Promise(resolve => {
        const dialog = document.createElement('dialog');
        dialog.className = 'tt-nas-dialog';
        const text = document.createElement('p'); text.textContent = message; dialog.append(text);
        const finish = value => { dialog.close(); dialog.remove(); resolve(value); };
        for (const [value, label] of choices) button(label, () => finish(value), dialog);
        dialog.addEventListener('cancel', event => { event.preventDefault(); finish('cancel'); });
        document.body.append(dialog); dialog.showModal();
    });
}

async function connect() {
    if (api) return api;
    // shortcut: TT 2.4.0 internal modules; recheck these imports when TT changes its frontend contract.
    const [bridge, panel, state, reports, lifecycle] = await Promise.all([
        import('/tauri-bridge.js'), import(`${base}sync-popup.js`), import(`${base}sync-state.js`),
        import(`${base}sync-listeners.js`), import('/tauri/main/services/lifecycle/lifecycle-flush-service.js'),
    ]);
    if (![bridge.invoke, panel.openSyncPopup, state.getSyncDatasetSelection, reports.showSyncReportResult,
        lifecycle.flushLifecycleState, lifecycle.registerLifecycleFlushHandler].every(fn => typeof fn === 'function')) {
        throw new Error('当前 TT 缺少兼容接口，请改用 TT 自带同步面板。');
    }
    api = { ...bridge, ...panel, ...state, ...reports, ...lifecycle };
    return api;
}

async function panel() {
    if (busy) { status('同步进行中，请等待完成。'); return; }
    await (await connect()).openSyncPopup();
    if (selected) await refreshServers();
}

async function refreshServers() {
    const servers = await (await connect()).invoke('tt_sync_list_servers');
    if (!Array.isArray(servers)) throw new Error('TT 返回的服务器列表不兼容。');
    selected.replaceChildren(new Option('请选择本机已配对的 NAS', ''));
    for (const server of servers) selected.add(new Option(`${server.server_device_name} · ${server.base_url}`, server.server_device_id));
    selected.value = config.serverId || '';
    if (!selected.value) status('先在原生同步面板配对，再选择 NAS；插件不会自动选择其他设备。');
}

async function transfer(direction, automatic = false) {
    if (busy) return;
    busy = true;
    const serverDeviceId = config.serverId;
    for (const control of root.querySelectorAll('button, select, input')) control.disabled = true;
    try {
        if (hostKind(window.__TAURITAVERN_HOST__) !== 'desktop') throw new Error('手机端请使用原生同步面板。');
        if (!serverDeviceId) throw new Error('请先选择已配对的 NAS。');
        if (direction === 'pull' && !automatic) {
            const answer = await choose('从 NAS 下载会按原生冲突策略处理同名文件。请确认另一台设备已经上传，且本机没有需要保留的未上传内容。', [['yes', '确认下载'], ['cancel', '取消']]);
            if (answer !== 'yes') return;
        }
        const a = await connect();
        const servers = await a.invoke('tt_sync_list_servers');
        if (!servers.some(server => server.server_device_id === serverDeviceId)) throw new Error('所选 NAS 配对已不存在，请重新配对。');
        const [catalog, nativeStatus] = await Promise.all([a.invoke('sync_get_dataset_catalog'), a.invoke('lan_sync_get_status')]);
        const options = makeOptions(catalog, a.getSyncDatasetSelection, nativeStatus);
        // Flush before invoking native sync, never from inside a lifecycle handler.
        await a.flushLifecycleState('nas-helper:before-sync');
        sessionStorage.setItem(ATTEMPT, '1');
        config.pending = true; save();
        status(direction === 'push' ? '正在增量上传到 NAS…' : '正在从 NAS 增量下载…');
        const report = await a.invoke(direction === 'push' ? 'tt_sync_push' : 'tt_sync_pull', {
            serverDeviceId, mode: 'Incremental', options,
        });
        if (completed(report)) {
            if (direction === 'push') { config.lastUpload = lastUploadThisSession = Date.now(); save(); }
            status(direction === 'push' ? `上传完成：${stamp(config.lastUpload)}` : '下载完成，确认原生提示后刷新。');
        } else status('同步未完成；不会记作上传成功。请查看原生错误提示。');
        await a.showSyncReportResult(report);
    } catch (error) {
        status(`同步失败：${String(error?.message || error)}。请确认节点小宝已连接，再打开原生面板检查。`);
    } finally {
        busy = false;
        for (const control of root.querySelectorAll('button, select, input')) control.disabled = false;
    }
}

async function closeReminder(reason) {
    if (reason !== 'tauri:exit-requested') return;
    if (busy) { status('同步尚未结束，请完成后再退出。'); throw new Error('NAS sync is running'); }
    const choices = [['cancel', '返回 TT，先上传'], ['exit', '直接退出，保留未交接提醒']];
    if (lastUploadThisSession) choices.push(['done', '确认上传后未再修改，退出']);
    const result = await choose(`离开前请确认最新聊天和千千结记忆已经上传。最近一次通过本插件上传：${stamp(config.lastUpload)}。插件无法判断所有扩展是否又写入了新内容。`, choices);
    if (result === 'cancel') { status('请点击“上传到 NAS”，完成后再退出。'); throw new Error('User stayed to upload'); }
    config.pending = result !== 'done'; save();
}

async function start() {
    if (document.getElementById(ROOT)) return;
    root = document.createElement('div'); root.id = ROOT;
    root.innerHTML = '<b>NAS 同步助手</b><div class="tt-nas-actions"></div><p role="status" aria-live="polite"></p>';
    const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!container) throw new Error('找不到扩展设置容器。');
    container.append(root);
    statusNode = root.querySelector('p');
    const actions = root.querySelector('.tt-nas-actions');
    button('打开同步面板', panel, actions);
    const kind = hostKind(window.__TAURITAVERN_HOST__);
    if (kind !== 'desktop') { status(kind === 'mobile' ? '手机模式：先连接节点小宝，再打开同步面板。' : '本插件仅支持 TauriTavern；请使用原生同步入口。'); return; }
    selected = document.createElement('select'); selected.setAttribute('aria-label', 'NAS 同步目标'); root.insertBefore(selected, actions);
    selected.addEventListener('change', () => { config.serverId = selected.value; config.autoDownload = false; auto.checked = false; save(); status('目标已保存。启动下载需在本机单独开启。'); });
    button('刷新已配对 NAS', refreshServers, actions);
    button('上传到 NAS', () => transfer('push'), actions);
    button('从 NAS 下载', () => transfer('pull'), actions);
    const label = document.createElement('label');
    const auto = document.createElement('input'); auto.type = 'checkbox'; auto.checked = config.autoDownload === true;
    label.append(auto, ' 下次启动自动从所选 NAS 下载（仅本机）'); root.append(label);
    auto.addEventListener('change', async () => {
        if (auto.checked && (!config.serverId || await choose('启用后，新启动会从 NAS 下载并可能替换同名文件。请坚持“上一台上传完成，再打开下一台”。上次未确认交接时会暂停自动下载。', [['yes', '启用'], ['cancel', '取消']]) !== 'yes')) auto.checked = false;
        config.autoDownload = auto.checked; save();
    });
    config.pending = true; save();
    const a = await connect();
    a.registerLifecycleFlushHandler('tt-nas-sync-helper', closeReminder, { priority: 10000 });
    await refreshServers();
    if (startupAllowed({kind, enabled: config.autoDownload, serverId: config.serverId, previousPending, attempted: sessionStorage.getItem(ATTEMPT) === '1'})) {
        sessionStorage.setItem(ATTEMPT, '1');
        await transfer('pull', true);
    } else if (config.autoDownload && previousPending && sessionStorage.getItem(ATTEMPT) !== '1') {
        status('上次未确认上传交接，已暂停启动下载。请先检查本机内容，再手动下载或上传。');
    } else status(`已就绪。最近通过本插件上传：${stamp(config.lastUpload)}。同步范围沿用原生面板，固定增量模式。`);
}

// Extension loader runs after TT initializes its host; DOM ready covers deferred loading.
const ready = document.readyState === 'loading' ? new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, {once:true})) : Promise.resolve();
void ready.then(start).catch(error => {
    console.error('[NAS Sync Helper]', error);
    status(`插件初始化失败：${String(error?.message || error)}。请使用 TT 原生同步面板。`);
});
