/** SSE framing is independent of network chunks and protocol JSON payloads. */
export class SseFramer {
  private pending = '';
  private first = true;
  private data: string[] = [];
  private event = '';
  constructor(private emit: (data: string, event: string) => void) {}
  private line(line: string) {
    if (!line) {
      if (this.data.length) this.emit(this.data.join('\n'), this.event);
      this.data = [];
      this.event = '';
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const name = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (name === 'data') this.data.push(value);
    if (name === 'event') this.event = value;
  }
  push(text: string) {
    if (this.first && text.length) {
      text = text.replace(/^\uFEFF/, '');
      this.first = false;
    }
    this.pending += text;
    let index: number;
    while ((index = this.pending.search(/[\r\n]/)) >= 0) {
      if (this.pending[index] === '\r' && index === this.pending.length - 1)
        break;
      const length = this.pending.slice(index, index + 2) === '\r\n' ? 2 : 1;
      this.line(this.pending.slice(0, index));
      this.pending = this.pending.slice(index + length);
    }
  }
  end() {
    if (this.pending.endsWith('\r')) {
      this.line(this.pending.slice(0, -1));
      this.pending = '';
    }
    // EOF does not dispatch an unterminated event.
    return Boolean(this.pending || this.data.length);
  }
}
