const MAX_BUFFERED_BYTES = 32 * 1024 * 1024

/** Bytes as they arrive, read in whatever sizes a protocol calls for. */
export class Bytes {
  readonly #source: { pause: () => void; resume: () => void }
  #chunks: Array<Buffer> = []
  #length = 0
  #offset = 0
  #paused = false
  #wanted = 0
  #wake: (() => void) | null = null
  #sink: ((chunk: Buffer) => void) | null = null

  constructor(source: { pause: () => void; resume: () => void }) {
    this.#source = source
  }

  push(chunk: Buffer) {
    if (this.#sink) {
      this.#sink(chunk)
      return
    }
    this.#chunks.push(chunk)
    this.#length += chunk.length
    if (this.#wake && this.#length >= this.#wanted) {
      const wake = this.#wake
      this.#wake = null
      wake()
    }
    if (!this.#paused && this.#length >= MAX_BUFFERED_BYTES) {
      this.#paused = true
      this.#source.pause()
    }
  }

  /** The next bytes if they've arrived, valid until the next read. */
  take(size: number): Buffer | null {
    if (this.#length < size) return null
    this.#length -= size
    const first = this.#chunks[0]
    let result: Buffer
    if (first && first.length - this.#offset >= size) {
      result = first.subarray(this.#offset, this.#offset + size)
      this.#offset += size
      if (this.#offset === first.length) {
        this.#chunks.shift()
        this.#offset = 0
      }
    } else {
      result = Buffer.allocUnsafe(size)
      let filled = 0
      while (filled < size) {
        const chunk = this.#chunks[0]
        if (!chunk) break
        const copied = chunk.copy(result, filled, this.#offset)
        filled += copied
        this.#offset += copied
        if (this.#offset === chunk.length) {
          this.#chunks.shift()
          this.#offset = 0
        }
      }
    }
    if (this.#paused && this.#length < MAX_BUFFERED_BYTES / 2) {
      this.#paused = false
      this.#source.resume()
    }
    return result
  }

  async read(size: number): Promise<Buffer> {
    const ready = this.take(size)
    if (ready) return ready
    await new Promise<void>((wake) => {
      this.#wanted = size
      this.#wake = wake
    })
    return this.take(size) ?? Buffer.alloc(0)
  }

  /** Hands everything from now on straight to `sink`. */
  drainTo(sink: (chunk: Buffer) => void) {
    const rest = this.take(this.#length)
    if (rest && rest.length > 0) sink(rest)
    this.#sink = sink
  }
}
