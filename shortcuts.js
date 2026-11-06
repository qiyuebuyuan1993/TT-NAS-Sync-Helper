export const QR_SET = 'TT-NAS-Sync-Helper';
export const SYNC_COMMAND = 'tt-nas-sync';

export async function ensureQuickReply(qr) {
    if (!qr) return false;
    let set = qr.getSetByName(QR_SET);
    if (!set) set = await qr.createSet(QR_SET, { disableSend: false, injectInput: false });
    if (!set.qrList.some(reply => reply.message?.trim() === `/${SYNC_COMMAND}`)) {
        qr.createQuickReply(QR_SET, 'NAS 同步', {
            message: `/${SYNC_COMMAND}`, title: '打开 TT 原生同步面板', showLabel: true,
        });
    }
    if (!qr.listGlobalSets().includes(QR_SET)) qr.addGlobalSet(QR_SET, true);
    return true;
}
