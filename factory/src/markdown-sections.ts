/** ATX sections outside fenced code. Offsets refer to the original UTF-16
 * snapshot, including its line endings and nested subsections. */
export function markdownSectionRange(text: string, heading: string) {
  const headings: { heading: string; level: number; start: number }[] = [];
  let fence: { marker: string; length: number } | undefined;
  let offset = 0;
  for (const raw of text.split(/(?<=\n)/u)) {
    const line = raw.replace(/\r?\n$/u, '');
    if (fence) {
      const close = /^ {0,3}(`+|~+)[ \t]*$/u.exec(line);
      if (close && close[1]![0] === fence.marker && close[1]!.length >= fence.length) fence = undefined;
    } else {
      const open = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
      if (open && !(open[1]![0] === '`' && open[2]!.includes('`'))) {
        fence = { marker: open[1]![0]!, length: open[1]!.length };
      } else {
        const match = /^ {0,3}(#{1,6})(?:[ \t]+|$)/u.exec(line);
        if (match) headings.push({ heading: line.trim(), level: match[1]!.length, start: offset });
      }
    }
    offset += raw.length;
  }
  const matches = headings.filter((entry) => entry.heading === heading.trim());
  if (matches.length !== 1) throw new Error('legacy_heading_missing_or_ambiguous');
  const target = matches[0]!;
  const end = headings.find((entry) => entry.start > target.start && entry.level <= target.level)?.start ?? text.length;
  return { start: target.start, end, before: text.slice(target.start, end) };
}
