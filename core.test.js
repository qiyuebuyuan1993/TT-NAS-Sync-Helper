import test from 'node:test';
import assert from 'node:assert/strict';
import {hostKind, startupAllowed, makeOptions, completed} from './core.js';

test('only known desktop hosts may automate', () => {
    assert.equal(hostKind({platform:'android'}), 'mobile');
    assert.equal(hostKind({kind:'desktop',platform:'windows'}), 'desktop');
    assert.equal(hostKind({}), 'unknown');
    const ready = {kind:'desktop',enabled:true,serverId:'nas',previousPending:false,attempted:false};
    assert.equal(startupAllowed(ready), true);
    for (const change of [{kind:'mobile'}, {enabled:false}, {serverId:''}, {previousPending:true}, {attempted:true}]) assert.equal(startupAllowed({...ready,...change}), false);
});
test('preserves scope and conflict policy; refuses missing memory dataset', () => {
    const catalog = {policy_version:2, supported_dataset_ids:['extensions.store','chat.character.history'], default_dataset_ids:['extensions.store']};
    const selection = {policy_version:2,dataset_ids:['extensions.store']};
    const options = makeOptions(catalog, normalized => {
        assert.equal(normalized.policyVersion, 2);
        assert.deepEqual(normalized.supportedDatasetIds, catalog.supported_dataset_ids);
        return selection;
    }, {overwrite_policy:'exact'});
    assert.deepEqual(options, {selection,overwrite_policy:'exact',require_bundle_zstd:true});
    assert.throws(() => makeOptions(catalog, () => ({dataset_ids:['chat.character.history']}), {overwrite_policy:'exact'}), /extensions.store/);
    assert.throws(() => makeOptions(catalog, () => selection, {}), /冲突/);
    assert.throws(() => makeOptions({}, () => selection, {}), /不兼容/);
});
test('failed, missing, or merely accepted reports never count as success', () => {
    for (const status of ['failed','remote_request_accepted',undefined]) assert.equal(completed({result:{status}}), false);
    assert.equal(completed(null), false);
    assert.equal(completed({result:{status:'completed'}}), true);
});
