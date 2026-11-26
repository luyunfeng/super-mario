// 一条 GitHub 收件的正文：合并请求或议题的说明，加上评论。经所选电脑读取，令牌不经过工作台。
import { h, replace } from '../lib/dom.js';
import { Button } from '../ui/kit.js';

function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' ? url.href : '';
  } catch { return ''; }
}

export function githubOriginalLink(item) {
  const target = item.raw?.origin?.github;
  if (!target || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/.test(target.repository) || !Number.isSafeInteger(target.number)) return null;
  // Built from the validated repository and number. No API-provided address is followed.
  const path = target.kind === 'pull' ? 'pull' : 'issues';
  return h('a', { class: 'btn btn--sm', href: 'https://github.com/' + target.repository + '/' + path + '/' + target.number, target: '_blank', rel: 'noopener noreferrer' }, '在 GitHub 打开');
}

/** `row` is the inbox item as stored. It is read once per item, when its detail opens. */
export function githubInboxBody(api, row) {
  const root = h('div', { class: 'stack', 'aria-label': 'GitHub 正文' });
  const target = row?.origin?.github;
  if (!target) return root;
  let page = 1, loaded = null, busy = false, seq = 0, error = '';
  const open = h('details', { open: true },
    h('summary', null, target.repository + (target.kind === 'pull' ? ' 的合并请求 #' : ' 的议题 #') + target.number));
  root.append(open);
  async function load() {
    const stamp = ++seq;
    busy = true; error = '';
    paint();
    try {
      const value = await api.get('/github/inbox/' + encodeURIComponent(row.id) + (page > 1 ? '?page=' + page : ''));
      if (stamp !== seq) return;
      loaded = value;
    } catch (cause) {
      if (stamp !== seq) return;
      error = cause.message;
    } finally { busy = false; if (stamp === seq) paint(); }
  }
  function paint() {
    replace(open,
      h('summary', null, target.repository + (target.kind === 'pull' ? ' 的合并请求 #' : ' 的议题 #') + target.number),
      busy && !loaded ? h('p', { class: 'small muted' }, '正在读取…') : null,
      error ? h('p', { class: 'small', role: 'alert' }, '无法读取正文：' + error, ' ',
        h('button', { type: 'button', class: 'btn btn--sm', onClick: () => { void load(); } }, '重试')) : null,
      loaded && [
        h('p', { class: 'small muted' }, [loaded.state, loaded.author && '由 ' + loaded.author + ' 发起', loaded.comments !== undefined && loaded.comments + ' 条评论'].filter(Boolean).join(' · ')),
        loaded.body ? h('pre', { class: 'mailbox-content' }, loaded.body) : h('p', { class: 'small muted' }, '没有说明正文。'),
        loaded.commentsPage.length ? h('div', { class: 'stack' }, loaded.commentsPage.map(comment => h('article', { class: 'stack' },
          h('div', { class: 'row row--between' }, h('strong', null, comment.author || '未知'), comment.createdAt && h('time', { class: 'small muted', dateTime: comment.createdAt }, new Date(comment.createdAt).toLocaleString())),
          h('pre', { class: 'mailbox-content' }, comment.body),
          safeUrl(comment.url) ? h('a', { class: 'small', href: safeUrl(comment.url), target: '_blank', rel: 'noopener noreferrer' }, '在 GitHub 查看这条评论') : null))) : null,
        loaded.commentsHasNext ? h('div', { class: 'row row--wrap' },
          page > 1 ? Button({ label: '上一页评论', size: 'sm', onClick: () => { page--; void load(); } }) : null,
          Button({ label: '下一页评论', size: 'sm', onClick: () => { page++; void load(); } })) : null,
      ]);
  }
  void load();
  return { el: root };
}
