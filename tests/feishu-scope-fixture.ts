// Offline directory and per-user settings used by collection tests.
export function chatDirectory(args: string[], ids: string[]) {
  if (args.includes('+chat-list')) return {ok: true, identity: 'user', data: {chats: ids.map(chat_id => ({chat_id})), has_more: false}};
  if (args.includes('batch_query')) {
    const requested: string[] = JSON.parse(args[args.indexOf('--data') + 1]!).chat_ids;
    return {ok: true, identity: 'user', data: {items: requested.filter(id => ids.includes(id)).map(chat_id => ({chat_id, is_muted: false}))}};
  }
}
