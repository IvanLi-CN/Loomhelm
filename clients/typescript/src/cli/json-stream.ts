/** Incremental JSON validator/projector. Tokens are capped, syntax is always fully consumed. */
export type JsonPath = (string | number)[];
export interface JsonEvent { path: JsonPath; value?: string | number | boolean | null; kind: 'scalar' | 'object' | 'array'; count?: number; truncated?: boolean }
type Frame = { kind: 'object' | 'array'; state: 'key' | 'key-required' | 'colon' | 'value' | 'value-required' | 'comma'; key: string; index: number };
export class JsonStream {
  private stack: Frame[] = [];
  private root: 'value' | 'done' = 'value';
  private mode: 'none' | 'string' | 'number' | 'literal' = 'none';
  private token = '';
  private length = 0;
  private escape = false;
  private unicode = '';
  private stringKey = false;
  private literal = '';
  private numberState = '';
  private decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  constructor(private emit: (event: JsonEvent) => void, private cap = 4096) {}
  get bufferedCharacters(): number { return this.token.length + this.unicode.length + this.stack.reduce((n, f) => n + f.key.length, 0); }
  get bufferedStateSize(): number { return this.stack.length + this.bufferedCharacters; }
  private fail(): never { throw new Error('FLOW_OUTPUT_INVALID: incomplete or invalid JSON output'); }
  private path(): JsonPath {
    return this.stack.map(f => f.kind === 'array' ? f.index : f.key);
  }
  private complete(): void {
    const f = this.stack.at(-1);
    if (f) { f.state = 'comma'; f.index++; } else this.root = 'done';
  }
  private append(c: string): void { this.length += c.length; if (this.token.length < this.cap) this.token += c.slice(0, this.cap - this.token.length); }
  private stringEnd(): void {
    if (this.stringKey) {
      const f = this.stack.at(-1)!;
      // Oversized keys remain bounded and cannot match a known display path.
      f.key = this.length > this.cap ? '[oversized-key]' : this.token;
      f.state = 'colon';
    } else {
      this.emit({ kind: 'scalar', path: this.path(), value: this.token, truncated: this.length > this.cap });
      this.complete();
    }
    this.mode = 'none'; this.token = ''; this.length = 0;
  }
  private primitiveEnd(): void {
    if (this.mode === 'number') {
      if (!['zero', 'int', 'frac', 'exp'].includes(this.numberState)) this.fail();
      this.emit({ kind: 'scalar', path: this.path(), value: this.length > this.cap ? this.token : Number(this.token), truncated: this.length > this.cap });
    } else {
      if (this.token !== this.literal) this.fail();
      this.emit({ kind: 'scalar', path: this.path(), value: this.literal === 'null' ? null : this.literal === 'true' });
    }
    this.mode = 'none'; this.token = ''; this.length = 0; this.complete();
  }
  private number(c: string): boolean {
    const s = this.numberState;
    if (/[0-9]/.test(c)) {
      if (s === 'zero') this.fail();
      this.numberState = s === 'start' ? (c === '0' ? 'zero' : 'int') : s === 'dot' || s === 'frac' ? 'frac' : ['e', 'sign', 'exp'].includes(s) ? 'exp' : 'int';
    } else if (c === '.' && ['zero', 'int'].includes(s)) this.numberState = 'dot';
    else if (/[eE]/.test(c) && ['zero', 'int', 'frac'].includes(s)) this.numberState = 'e';
    else if (/[+-]/.test(c) && s === 'e') this.numberState = 'sign';
    else return false;
    this.append(c); return true;
  }
  write(bytes: Uint8Array): void { this.read(this.decoder.decode(bytes, { stream: true })); }
  private read(text: string): void {
    for (let i = 0; i < text.length; i++) {
      const c = text[i]!;
      if (this.mode === 'string') {
        if (this.unicode) {
          if (!/[0-9a-fA-F]/.test(c)) this.fail();
          this.unicode += c;
          if (this.unicode.length === 5) { this.append(String.fromCharCode(parseInt(this.unicode.slice(1), 16))); this.unicode = ''; }
        } else if (this.escape) {
          this.escape = false;
          if (c === 'u') this.unicode = 'u';
          else {
            const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
            if (!(c in escapes)) this.fail();
            this.append(escapes[c]!);
          }
        } else if (c === '\\') this.escape = true;
        else if (c === '"') this.stringEnd();
        else { if (c.charCodeAt(0) < 32) this.fail(); this.append(c); }
        continue;
      }
      if (this.mode === 'number') { if (this.number(c)) continue; this.primitiveEnd(); }
      if (this.mode === 'literal') {
        if (this.token.length < this.literal.length) {
          if (c !== this.literal[this.token.length]) this.fail();
          this.append(c); continue;
        }
        this.primitiveEnd();
      }
      if (/^[\x20\t\r\n]$/.test(c)) continue;
      const f = this.stack.at(-1);
      if (!f && this.root === 'done') this.fail();
      if (f?.state === 'colon') { if (c !== ':') this.fail(); f.state = 'value-required'; continue; }
      if (f?.state === 'comma') {
        if (c === ',') { f.state = f.kind === 'object' ? 'key-required' : 'value-required'; continue; }
        if (c !== (f.kind === 'object' ? '}' : ']')) this.fail();
      }
      if (c === '}' || c === ']') {
        if (!f || c !== (f.kind === 'object' ? '}' : ']') || !['key', 'value', 'comma'].includes(f.state)) this.fail();
        this.stack.pop(); this.emit({ kind: f.kind, path: this.path(), count: f.index }); this.complete(); continue;
      }
      if (f && ['key', 'key-required'].includes(f.state)) {
        if (c !== '"') this.fail();
        this.mode = 'string'; this.stringKey = true; continue;
      }
      if (c === '{' || c === '[') {
        this.stack.push({ kind: c === '{' ? 'object' : 'array', state: c === '{' ? 'key' : 'value', key: '', index: 0 }); continue;
      }
      if (c === '"') { this.mode = 'string'; this.stringKey = false; continue; }
      if (c === '-' || /[0-9]/.test(c)) {
        this.mode = 'number'; this.numberState = 'start';
        if (c === '-') this.append(c); else this.number(c);
        continue;
      }
      if ('tfn'.includes(c)) { this.mode = 'literal'; this.literal = c === 't' ? 'true' : c === 'f' ? 'false' : 'null'; this.append(c); continue; }
      this.fail();
    }
  }
  finish(): void {
    this.read(this.decoder.decode());
    if (this.mode === 'number' || this.mode === 'literal') this.primitiveEnd();
    if (this.mode !== 'none' || this.stack.length || this.root !== 'done') this.fail();
  }
}
