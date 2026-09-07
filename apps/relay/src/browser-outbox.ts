import { WebSocket } from "ws"

interface OutboxItem {
  readonly action?: string
  readonly bytes: number
  readonly encoded: string
}

export type BrowserOutboxKind = "console" | "priority" | "resource"

export class BrowserOutbox {
  readonly #authorize: (action?: string) => boolean
  readonly #maxBytes: number
  readonly #maxMessages: number
  readonly #normal: Array<OutboxItem> = []
  readonly #priority: Array<OutboxItem> = []
  readonly #socket: WebSocket
  #bytes = 0
  #closed = false
  #resource: OutboxItem | null = null
  #sending = false

  constructor(options: {
    readonly authorize: (action?: string) => boolean
    readonly maxBytes: number
    readonly maxMessages: number
    readonly socket: WebSocket
  }) {
    this.#authorize = options.authorize
    this.#maxBytes = options.maxBytes
    this.#maxMessages = options.maxMessages
    this.#socket = options.socket
  }

  send(encoded: string, kind: BrowserOutboxKind, action?: string): boolean {
    if (
      this.#closed ||
      this.#socket.readyState !== WebSocket.OPEN ||
      !this.#authorize(action)
    ) {
      return false
    }
    const item = { action, bytes: Buffer.byteLength(encoded), encoded }
    if (item.bytes > this.#maxBytes) {
      this.#overflow()
      return false
    }
    if (kind === "resource") {
      if (this.#resource) this.#bytes -= this.#resource.bytes
      this.#resource = item
      this.#bytes += item.bytes
    } else {
      const queue = kind === "priority" ? this.#priority : this.#normal
      queue.push(item)
      this.#bytes += item.bytes
    }
    if (
      this.#bytes > this.#maxBytes ||
      this.#messageCount() > this.#maxMessages
    ) {
      this.#overflow()
      return false
    }
    this.#drain()
    return true
  }

  close(): void {
    this.#closed = true
    this.#priority.length = 0
    this.#normal.length = 0
    this.#resource = null
    this.#bytes = 0
  }

  #messageCount(): number {
    return (
      this.#priority.length + this.#normal.length + (this.#resource ? 1 : 0)
    )
  }

  #next(): OutboxItem | null {
    const item =
      this.#priority.shift() ?? this.#normal.shift() ?? this.#resource ?? null
    if (item === this.#resource) this.#resource = null
    if (item) this.#bytes -= item.bytes
    return item
  }

  #drain(): void {
    if (this.#sending || this.#closed) return
    const item = this.#next()
    if (!item) return
    if (!this.#authorize(item.action)) {
      this.#drain()
      return
    }
    this.#sending = true
    this.#socket.send(item.encoded, (cause) => {
      this.#sending = false
      if (cause) {
        this.#closed = true
        if (this.#socket.readyState === WebSocket.OPEN) {
          this.#socket.close(1013, "Browser delivery failed")
        }
        return
      }
      this.#drain()
    })
  }

  #overflow(): void {
    this.close()
    if (
      this.#socket.readyState === WebSocket.OPEN ||
      this.#socket.readyState === WebSocket.CONNECTING
    ) {
      this.#socket.close(1013, "Browser is not consuming messages")
    }
  }
}
