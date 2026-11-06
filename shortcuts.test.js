import test from 'node:test';
import assert from 'node:assert/strict';
import {ensureQuickReply, QR_SET} from './shortcuts.js';

test('QR installation is idempotent and preserves existing user buttons', async () => {
    let set;
    const active = [];
    let creations = 0;
    const qr = {
        getSetByName: () => set,
        createSet: async (name, options) => { creations++; assert.equal(options.injectInput,false); return set = {qrList:[{label:'custom',message:'/echo hello'}]}; },
        createQuickReply: (name,label,props) => { assert.equal(name,QR_SET); set.qrList.push({label,...props}); },
        listGlobalSets: () => active,
        addGlobalSet: name => active.push(name),
    };
    assert.equal(await ensureQuickReply(undefined), false);
    await ensureQuickReply(qr); await ensureQuickReply(qr);
    assert.equal(creations,1);
    assert.deepEqual(active,[QR_SET]);
    assert.equal(set.qrList.length,2);
    assert.equal(set.qrList[0].message,'/echo hello');
    assert.equal(set.qrList[1].message,'/tt-nas-sync');
});
