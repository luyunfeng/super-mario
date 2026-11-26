import type { MailConnectorState } from '../../protocol/src/index.ts';

/** A setting that is not well formed. It is the owner's input, and is answered as such. */
export class MailConnectorSettingError extends Error {
  readonly status = 400;
  constructor(message: string) { super(message); this.name = 'MailConnectorSettingError'; }
}

/** Checks what the owner changes about mail going into the inbox.
 *
 *  Only the switch and the folders can be changed. Anything else on the request is refused by
 *  name, so a field that means something else cannot slip in. A folder list that is left out
 *  keeps the one there was: turning mail off and on again must not forget the choice. */
export function configureMailConnector(current: MailConnectorState, input: Record<string, unknown>): MailConnectorState {
  const extra = Object.keys(input).find(key => !['enabled', 'folders'].includes(key));
  if (extra) throw new MailConnectorSettingError('邮箱连接参数无效：' + extra);
  if (typeof input.enabled !== 'boolean') throw new MailConnectorSettingError('请说明是否把邮件放进收件箱');
  let folders: string[] | undefined;
  if (input.folders !== undefined) {
    const list = input.folders;
    // A folder name is the owner's own data and is sent to the mail server as it is, so it is
    // checked for shape only: not empty, not too long, and with no control characters.
    if (!Array.isArray(list) || list.length > 30 || list.some(name => typeof name !== 'string' || !name || name.length > 512 || /[\u0000-\u001f\u007f]/.test(name)))
      throw new MailConnectorSettingError('文件夹名称无效');
    folders = [...new Set(list)];
  }
  return { ...current, enabled: input.enabled, ...(folders ? { folders } : {}) };
}
