/**
 * Incremental parser for text/event-stream response bodies.
 */

import { formatBytes } from './media.js';

export interface ServerSentEvent {
  type: string;
  data: string;
}

export class ServerSentEventParser {
  private readonly lineEnd = /\r\n|\r|\n/g;
  private partialLine = '';
  private data: string | undefined;
  private eventType = '';
  private skipLeadingLineFeed = false;

  constructor(private readonly maxLength: number) {}

  push(text: string): ServerSentEvent[] {
    const events: ServerSentEvent[] = [];
    let position = 0;

    // A CRLF split across two chunks is one line ending, not two.
    if (this.skipLeadingLineFeed && text.length > 0) {
      if (text.charCodeAt(0) === 0x0a) position = 1;
      this.skipLeadingLineFeed = false;
    }

    this.lineEnd.lastIndex = position;
    let match: RegExpExecArray | null;
    while ((match = this.lineEnd.exec(text)) !== null) {
      const line = this.partialLine + text.slice(position, match.index);
      this.partialLine = '';
      this.assertWithinLimit(line.length, 'line');
      this.processLine(line, events);
      position = match.index + match[0].length;
      if (match[0] === '\r' && position === text.length) {
        this.skipLeadingLineFeed = true;
      }
    }

    if (position < text.length) {
      this.partialLine += text.slice(position);
      this.assertWithinLimit(this.partialLine.length, 'line');
    }
    return events;
  }

  end(text = ''): ServerSentEvent[] {
    const events = this.push(text);
    // An event whose last line ended cleanly is kept even without the closing
    // blank line; a cut-off line is discarded.
    if (this.partialLine === '') {
      this.dispatch(events);
    }
    this.partialLine = '';
    this.data = undefined;
    this.eventType = '';
    return events;
  }

  private processLine(line: string, events: ServerSentEvent[]): void {
    if (line === '') {
      this.dispatch(events);
      return;
    }
    if (line.startsWith(':')) return;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'data') {
      this.data = this.data === undefined ? value : `${this.data}\n${value}`;
      this.assertWithinLimit(this.data.length, 'event');
    } else if (field === 'event') {
      this.eventType = value;
    }
  }

  private dispatch(events: ServerSentEvent[]): void {
    if (this.data !== undefined) {
      events.push({ type: this.eventType || 'message', data: this.data });
    }
    this.data = undefined;
    this.eventType = '';
  }

  private assertWithinLimit(length: number, kind: 'line' | 'event'): void {
    if (length > this.maxLength) {
      throw new Error(
        `Event stream ${kind} exceeded the limit of ${formatBytes(this.maxLength)}.`
      );
    }
  }
}
