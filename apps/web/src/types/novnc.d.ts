declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    _sock: { _websocket: WebSocket | null }
    constructor(target: HTMLElement, url: string)
    addEventListener(
      type: "desktopname",
      listener: (event: CustomEvent<{ name: string }>) => void
    ): void
    addEventListener(
      type: "clipboard",
      listener: (event: CustomEvent<{ text: string }>) => void
    ): void
    addEventListener(type: string, listener: EventListener): void
    focusOnClick: boolean
    scaleViewport: boolean
    showDotCursor: boolean
    disconnect(): void
    focus(): void
    sendCredentials(credentials: { password: string; username: string }): void
    sendKey(keysym: number, code: string | null, down?: boolean): void
  }
}
