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
  readonly #roomWaiters: Array<{
    readonly bytes: number
    readonly resolve: (open: boolean) => void
  }> = []
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

  // Resolves once `bytes` more fit in half the outbox, or false once it has
  // closed. Bursts larger than the outbox, like a console's history, send
  // through this a message at a time, leaving the other half for live
  // messages.
  whenRoomFor(bytes: number): Promise<boolean> {
    if (this.#closed) return Promise.resolve(false)
    if (this.#roomWaiters.length === 0 && this.#hasRoomFor(bytes)) {
      return Promise.resolve(true)
    }
    return new Promise((resolve) => {
      this.#roomWaiters.push({ bytes, resolve })
    })
  }

  close(): void {
    this.#closed = true
    this.#priority.length = 0
    this.#normal.length = 0
    this.#resource = null
    this.#bytes = 0
    for (const waiter of this.#roomWaiters.splice(0)) waiter.resolve(false)
  }

  #hasRoomFor(bytes: number): boolean {
    return (
      this.#messageCount() === 0 ||
      (this.#bytes + bytes <= this.#maxBytes / 2 &&
        this.#messageCount() < this.#maxMessages / 2)
    )
  }

  // One waiter at a time, so each sends before the next is measured. A
  // waiter that doesn't send doesn't hold up the rest: the next is checked
  // again shortly.
  #wakeRoomWaiter(): void {
    const waiter = this.#roomWaiters[0]
    if (!waiter || this.#closed || !this.#hasRoomFor(waiter.bytes)) return
    this.#roomWaiters.shift()
    waiter.resolve(true)
    if (this.#roomWaiters.length > 0) {
      setImmediate(() => this.#wakeRoomWaiter())
    }
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
    if (!item) {
      this.#wakeRoomWaiter()
      return
    }
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
      this.#wakeRoomWaiter()
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
