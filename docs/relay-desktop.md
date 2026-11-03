# Relay desktop

A Relay's **Desktop** tab shows its node's graphical desktop in the browser,
with keyboard, mouse, clipboard, and sound. [voxl](https://github.com/tembo/voxl)
does the streaming: H.264 over one WebSocket, decoded with WebCodecs.

Hearth: `server/relay-desktop.ts`, `lib/relay-desktop.server.ts`,
`components/relay/relay-desktop-page.tsx`, `public/desktop-client`.
Relay: `desktop.ts`. Image: `apps/desktop/Dockerfile`.

## What a node needs

- A streamer image, named by `KILN_RELAY_DESKTOP_IMAGE`. Kiln doesn't publish
  one yet (see [Licensing](#licensing)), so the tab stays off until a Relay is
  given one built from `apps/desktop`.
- Host access on (`KILN_RELAY_HOST_ACCESS`, the default). The Relay finds the
  desktop through the same helper as the host terminal.
- An **X11** session someone is signed in to, or a login screen on X11. voxl
  doesn't capture Wayland yet, and GNOME and KDE default to it. To use one
  here, sign in with an Xorg session such as "GNOME on Xorg", or set
  `WaylandEnable=false` in `/etc/gdm3/daemon.conf`.
- Docker running the Relay in a container, as every install does.

Opening the desktop needs `relay.terminal`: driving someone's desktop is worth
as much as a root shell on the node. A node with nothing to show still opens
the tab, grayed out, with a link to its terminal.

## How it connects

```
browser ──HTTPS/WSS──▶ Hearth ──control endpoint or tunnel──▶ Relay ──127.0.0.1──▶ voxl ──▶ X server
```

1. The page asks for `relay.desktop.read`. The Relay runs a script on the host
   that reads logind for the active graphical session and, for X11, finds the
   display and its cookie in that person's processes.
2. `relay.desktop.attach` starts the streamer if it isn't running and returns a
   random **ticket**. Hearth keeps the ticket and gives the page a session key.
3. The page loads voxl's client from Hearth, whose WebSocket comes back to
   `/desktop-client/ws?relay=<id>&session=<key>`.
4. Hearth checks the `Origin`, the sign-in, that the session is this person's,
   and the permission. It then opens `/v1/desktop/<ticket>/ws` on the Relay and
   joins the two connections, bytes unchanged.
5. The Relay checks the ticket and joins that connection to voxl, adding voxl's
   password. The browser never sees the ticket or the password.
6. Hearth answers the browser with a handshake it writes itself, after checking
   the Relay's `Sec-WebSocket-Accept`. None of the Relay's headers are passed
   on: they would otherwise arrive from Hearth's origin, as `Set-Cookie` could.

The stream doesn't use [browser capabilities](relay-browser-sessions.md): the
client is voxl's and can't sign proofs, and a stream carried at the byte level
needs no renewal messages. Instead Hearth renews the ticket and rechecks the
sign-in and permission every 20 seconds, so a lost permission ends the stream
within that time. A ticket lapses 60 seconds after its last renewal.

A stream that can't go on ends its Hearth session: the Relay restarted and lost
its tickets, the streamer is gone, which ends its ticket at the next attempt,
no stream has run for a minute, or access is gone. voxl's
client would keep trying, so the page checks its session every 10 seconds and,
without one, opens another, which finds whatever the node shows now.

## Why Hearth serves the client

The client's JavaScript runs on Hearth's origin, where it could use the
person's session. So it's never fetched from a node: `public/desktop-client`
is a copy from the pinned voxl version, and a Relay only ever supplies video
and audio frames. Update that copy whenever `VOXL_VERSION` changes.

## The streamer

`kiln-desktop` (`<namespace>-kiln-desktop` for a namespaced Relay) is created
on the first attach and removed after 5 minutes unwatched. It runs:

- as the signed-in person's UID and GID, with no capabilities;
- in the Relay's network namespace, listening on `127.0.0.1:47901`, so nothing
  outside the Relay can reach it;
- in the host's IPC namespace, for MIT-SHM capture;
- with only the display's socket, its cookie (read-only), and the PulseAudio
  socket mounted.

A change of display, person, or image replaces it, and so does a streamer that
runs but doesn't answer: it shares the network namespace of the Relay container
that started it, so restarting the Relay strands it. voxl's own file transfer,
microphone, and resizing are off: Kiln has host files, and a viewer's window
shouldn't change the size of a physical monitor.

Starting and stopping it take the `relay:desktop` lane, so a streamer that's
been idle is never removed from under someone attaching. Pausing the Relay ends
every stream and refuses new ones, since a stream takes input.

The detection script's answers about the display and its cookie come from the
environment of the signed-in person's processes, which they control. The Relay
takes only exact shapes, mounts only a regular file that person owns, runs the
streamer as the UID logind reports, and never streams a root session.

## Keyboard, fullscreen, and touch

voxl sends each key to the desktop as an X keysym, so the viewer's layout
decides what it types. A Mac's Command key becomes Control, so Linux shortcuts
work with either, and Command can't send Super.

A browser and the viewer's own computer keep some shortcuts for themselves, such
as Ctrl+W, Cmd+Tab, and Ctrl+Alt+Delete. There are two ways past that:

- **Fullscreen** takes the keyboard in Chromium browsers. Only a top-level page
  may call Keyboard Lock, so Hearth's page does it, not voxl's. Hold Esc to
  leave. Without Keyboard Lock, Esc leaves fullscreen and the browser keeps its
  shortcuts.
- **Send keys** presses a chosen combination through voxl's keyboard handlers,
  and is the only way to send Super from a Mac.

Where a browser has no fullscreen for pages, as on iPhones, the desktop fills
the window instead.

On touch screens, tap clicks, long press right-clicks, one finger drags, and two
fingers scroll. voxl's toolbar adds an on-screen keyboard button. There's no
pinch zoom, and a physical monitor isn't resized to fit, so a 1080p desktop shows
at about a fifth of its size on a phone held upright.

## Licensing

voxl is MIT, but its binary links x264 (GPL-2.0), so the streamer image is
distributed under the GPL. It's a separate program in its own image, which
Kiln's images don't include, and CI only builds it. Check the license terms
before publishing it, then give `KILN_RELAY_DESKTOP_IMAGE` a default.

## Limits

- The stream always runs through Hearth, so its bitrate (up to 30 Mbps) counts
  against Hearth's bandwidth and adds a hop. Relays browsers can reach could
  take it directly.
- One display per node. Viewers share it, and all of them can type.
- voxl encodes on the CPU: about 1.5 cores on a busy desktop.
