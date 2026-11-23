import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt();
export function documentHeadings(content: string) {
  const tokens = markdown.parse(content, {});
  return tokens.flatMap((token, index) => {
    if (token.type !== 'heading_open' || !token.map) return [];
    const title = tokens[index + 1]?.content.trim();
    return title ? [{ title, level: Number(token.tag.slice(1)), line: token.map[0] + 1 }] : [];
  });
}
