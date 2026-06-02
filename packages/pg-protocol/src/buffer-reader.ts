// Decode a UTF-8 string from a Buffer slice. `Buffer.prototype.toString`
// re-resolves the encoding (getEncodingOps) and validates the offsets on every
// call; `utf8Slice` is the underlying fast path that skips both. We feature
// detect it once so non-Node Buffer implementations (e.g. polyfills used on
// Cloudflare Workers) fall back to the standard, always-available `toString`.
type Utf8SliceBuffer = Buffer & { utf8Slice(start: number, end: number): string }
const hasUtf8Slice = typeof (Buffer.prototype as Partial<Utf8SliceBuffer>).utf8Slice === 'function'

export const decodeUtf8: (buffer: Buffer, start: number, end: number) => string = hasUtf8Slice
  ? (buffer, start, end) => (buffer as Utf8SliceBuffer).utf8Slice(start, end)
  : (buffer, start, end) => buffer.toString('utf8', start, end)

export class BufferReader {
  private buffer: Buffer = Buffer.allocUnsafe(0)

  constructor(private offset: number = 0) {}

  public setBuffer(offset: number, buffer: Buffer): void {
    this.offset = offset
    this.buffer = buffer
  }

  public int16(): number {
    const result = this.buffer.readInt16BE(this.offset)
    this.offset += 2
    return result
  }

  public byte(): number {
    const result = this.buffer[this.offset]
    this.offset++
    return result
  }

  public int32(): number {
    const result = this.buffer.readInt32BE(this.offset)
    this.offset += 4
    return result
  }

  public uint32(): number {
    const result = this.buffer.readUInt32BE(this.offset)
    this.offset += 4
    return result
  }

  public string(length: number): string {
    const offset = this.offset
    const end = offset + length
    const result = decodeUtf8(this.buffer, offset, end)
    this.offset = end
    return result
  }

  public cstring(): string {
    const buffer = this.buffer
    const start = this.offset
    let end = start
    // eslint-disable-next-line no-empty
    while (buffer[end++] !== 0) {}
    this.offset = end
    return decodeUtf8(buffer, start, end - 1)
  }

  public bytes(length: number): Buffer {
    const result = this.buffer.slice(this.offset, this.offset + length)
    this.offset += length
    return result
  }
}
