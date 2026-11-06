import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as core from './core.js';
import * as shortcuts from './shortcuts.js';

const source = await readFile(new URL('./index.js', import.meta.url), 'utf8');
const key = 'tt-nas-sync-helper:v1';
const tick = () => new Promise(resolve => setImmediate(resolve));

async function harness({kind = 'desktop', config = {}, session = {}, fail = false, invokeError = false} = {}) {
    const nodes = [];
    class Element {
        constructor(tag) { this.tag = tag; this.children = []; this.events = {}; this.value = ''; nodes.push(this); }
        append(...items) { this.children.push(...items); }
        set innerHTML(value) { this.append(new Element('b'), new Element('actions'), new Element('p')); }
        addEventListener(name, fn) { this.events[name] = fn; }
        setAttribute() {}
        querySelector(selector) { return this.children.find(node => node.tag === (selector === 'p' ? 'p' : 'actions')); }
        querySelectorAll() { return nodes.filter(node => ['button', 'select', 'input'].includes(node.tag)); }
        insertBefore(node) { this.append(node); }
        replaceChildren(...items) { this.children = items; }
        add(option) { this.append(option); }
        showModal() { this.open = true; }
        close() { this.open = false; }
        remove() { this.removed = true; }
    }
    const container = new Element('container');
    const menu = new Element('menu');
    const document = {
        readyState: 'complete', body: new Element('body'),
        getElementById: id => id === 'extensions_settings2' ? container : id === 'extensionsMenu' ? menu : nodes.find(node => node.id === id),
        createElement: tag => new Element(tag),
    };
    const storage = new Map([[key, JSON.stringify(config)]]);
    const sessionMap = new Map(Object.entries(session));
    const storageAPI = map => ({getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value)});
    const calls = [];
    let lifecycle;
    let slashCommand;
    const native = {
        invoke: async (command, args) => {
            calls.push([command,args]);
            if (command === 'tt_sync_list_servers') return [{server_device_id:'nas',server_device_name:'NAS',base_url:'https://example.invalid'}];
            if (command === 'sync_get_dataset_catalog') return {policy_version:1,supported_dataset_ids:['extensions.store'],default_dataset_ids:['extensions.store']};
            if (command === 'lan_sync_get_status') return {overwrite_policy:'exact'};
            if (command === 'tt_sync_push' || command === 'tt_sync_pull') {
                if (invokeError) throw new Error('offline');
                return {result:{status:fail ? 'failed' : 'completed'}};
            }
            throw Error(`Unexpected ${command}`);
        },
        openSyncPopup: async () => calls.push(['panel']),
        getSyncDatasetSelection: catalog => ({policy_version:catalog.policyVersion,dataset_ids:catalog.defaultDatasetIds}),
        showSyncReportResult: async report => calls.push(['report',report]),
        flushLifecycleState: async reason => { calls.push(['flush',reason]); await lifecycle?.(reason); },
        registerLifecycleFlushHandler: (name, fn) => { lifecycle = fn; },
        SlashCommandParser: {addCommandObject: command => { slashCommand = command; }},
        SlashCommand: {fromProps: props => props},
    };
    const qr = { getSetByName: () => ({qrList:[{message:'/tt-nas-sync'}]}), listGlobalSets: () => ['TT-NAS-Sync-Helper'] };
    const context = vm.createContext({console, document, setTimeout, Option: class {constructor(text,value){this.text=text;this.value=value;}},
        window:{__TAURITAVERN_HOST__:{kind},quickReplyApi:qr}, localStorage:storageAPI(storage), sessionStorage:storageAPI(sessionMap)});
    const moduleFor = async obj => {
        const module = new vm.SyntheticModule(Object.keys(obj), function(){for(const [key,value] of Object.entries(obj)) this.setExport(key,value);}, {context});
        await module.link(() => {}); await module.evaluate(); return module;
    };
    const nativeModule = await moduleFor(native);
    const rootModule = new vm.SourceTextModule(source, {context, importModuleDynamically: async () => nativeModule});
    await rootModule.link(spec => moduleFor(spec === './shortcuts.js' ? shortcuts : core)); await rootModule.evaluate(); await tick();
    const click = async text => {
        const node = nodes.findLast(node => node.tag === 'button' && node.textContent === text);
        assert.ok(node, `button ${text}`); assert.ok(!node.disabled);
        node.events.click(); await tick();
    };
    return {calls, nodes, storage, sessionMap, click, close: reason => lifecycle(reason),
        slash: () => slashCommand.callback(),
        config: () => JSON.parse(storage.get(key))};
}

test('mobile only opens native panel and never registers desktop automation', async () => {
    const h = await harness({kind:'mobile',config:{serverId:'nas',autoDownload:true}});
    assert.deepEqual(h.calls, []);
    assert.ok(!h.nodes.some(node => node.textContent === '上传到 NAS'));
    await h.click('打开同步面板');
    assert.deepEqual(h.calls, [['panel']]);
});

test('startup download is incremental, flushed first, and reload guarded', async () => {
    const h = await harness({config:{serverId:'nas',autoDownload:true}});
    const commands = h.calls.map(call => call[0]);
    assert.ok(commands.indexOf('flush') < commands.indexOf('tt_sync_pull'));
    const args = h.calls.find(call => call[0] === 'tt_sync_pull')[1];
    assert.equal(args.mode, 'Incremental'); assert.equal(args.serverDeviceId, 'nas');
    assert.equal(h.config().pending, true);
    const reloaded = await harness({config:h.config(),session:Object.fromEntries(h.sessionMap)});
    assert.ok(!reloaded.calls.some(call => call[0] === 'tt_sync_pull'));
});

test('unconfirmed previous session blocks automatic download', async () => {
    const h = await harness({config:{serverId:'nas',autoDownload:true,pending:true}});
    assert.ok(!h.calls.some(call => call[0] === 'tt_sync_pull'));
});

test('failed reports and offline throws leave no successful upload timestamp', async () => {
    for (const behavior of [{fail:true}, {invokeError:true}]) {
        const h = await harness({...behavior,config:{serverId:'nas'}});
        await h.click('上传到 NAS');
        assert.equal(h.config().lastUpload, undefined);
        assert.equal(h.config().pending, true);
        assert.ok(h.nodes.filter(node => node.tag === 'button').every(node => !node.disabled));
    }
});

test('close cancellation keeps app open; only explicit handoff clears pending', async () => {
    const h = await harness({config:{serverId:'nas'}});
    await h.close('visibilitychange:hidden');
    assert.equal(h.nodes.some(node => node.tag === 'dialog'), false);
    const closing = h.close('tauri:exit-requested');
    const rejection = assert.rejects(closing, /stayed/);
    await h.click('返回 TT，打开同步'); await rejection;
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(h.calls.some(call => call[0] === 'panel'));
    assert.equal(h.config().pending, true);
    await h.click('上传到 NAS');
    assert.ok(h.config().lastUpload > 0);
    const nextClose = h.close('tauri:exit-requested');
    await h.click('确认上传后未再修改，退出'); await nextClose;
    assert.equal(h.config().pending, false);
});

test('wand and slash/QR command both open the panel without syncing', async () => {
    const h = await harness({kind:'mobile'});
    await h.click('NAS 同步');
    assert.equal(await h.slash(), '');
    assert.equal(h.calls.filter(call => call[0] === 'panel').length, 2);
    assert.ok(!h.calls.some(call => /^tt_sync_(push|pull)$/.test(call[0])));
});
