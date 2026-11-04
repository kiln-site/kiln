# Relay desktop

A Relay's **Desktop** tab shows its node's graphical desktop in the browser.
How depends on the node:

| Node             | Shown by                                                            | Backend                     | Client                 |
| ---------------- | ------------------------------------------------------------------- | --------------------------- | ---------------------- |
| Linux, with X11  | [voxl](https://github.com/tembo/voxl), H.264 decoded with WebCodecs | `desktop-voxl.ts`           | voxl's own, in a frame |
| Mac, with Docker | macOS's Screen Sharing, as H.264 or JPEG through the Relay          | `desktop-screen-sharing.ts` | noVNC                  |

Relay: `desktop.ts` keeps what they share: tickets, streams, pausing, and letting
go once nobody's watching. Each backend implements `DesktopBackend`
(`desktop-backend.ts`), and the first whose `applies()` is true shows the node.
Hearth: `server/relay-desktop.ts`, `lib/relay-desktop.server.ts`.
Page: `components/relay/relay-desktop-page.tsx` is the toolbar and session around
a `DesktopClient` (`relay-desktop-surface.ts`), one per backend. A new way of
showing a desktop is one backend, one client, and a status in
`relayDesktopSchema`.

## What a Linux node needs

- Host access on (`KILN_RELAY_HOST_ACCESS`, the default). The Relay finds the
  desktop through the same helper as the host terminal.
- An **X11** session someone is signed in to, or a login screen on X11. voxl
  doesn't capture Wayland yet, and GNOME and KDE default to it. To use one
  here, sign in with an Xorg session such as "GNOME on Xorg", or set
  `WaylandEnable=false` in `/etc/gdm3/daemon.conf`.
- Docker running the Relay in a container, as every install does.

Nothing needs setting up. The first time someone opens a node's desktop, the
Relay downloads the streamer, `ghcr.io/kiln-site/desktop:<tag>` (a
fork's own, for a fork's Relay). `KILN_RELAY_DESKTOP_IMAGE` names another image
to use instead, such as a build of `apps/desktop` on an offline node.

Opening the desktop needs `relay.terminal`: driving someone's desktop is worth
as much as a root shell on the node. A node with nothing to show still opens
the tab, grayed out, with a link to its terminal.

## What a Mac needs

Docker on a Mac runs containers in a Linux VM. Nothing there can capture the
Mac's screen, but it can reach services on the Mac, so the Relay uses the VNC
server macOS already has:

1. Install the Relay as usual. Nothing changes in Docker.
2. Turn on Screen Sharing in System Settings, under General, Sharing. Only
   someone at the Mac can. The tab says so until it's on, and notices when it
   is.
3. Sign in on the tab with a Mac account Screen Sharing allows.

No port forward is needed, and nothing is installed on the Mac. The first time
someone opens the desktop it shows as JPEG, while the Relay downloads the desktop
image for its video encoder in the background. Once that's done, opening it again
gets video where the browser can decode it. The Relay reaches `host.docker.internal:5900` and connects out to
Hearth as it always does. It tells a Mac apart by what Docker reports:
`OrbStack`, or `Docker Desktop` with
its socket under `/Users`. It sees Screen Sharing is on when the port greets it
as a VNC server. `KILN_RELAY_SCREEN_SHARING_ADDRESS` overrides where it looks,
for another Docker runtime. Turning host access off turns this off too.

The viewer needs both `relay.terminal` in Kiln and a Mac login. The Mac login
goes from the browser to the Mac inside Apple's own sign-in exchange, which the
Relay passes along unread, and Kiln doesn't save it.

OrbStack's VM can also run commands on the Mac: its `mac` command does, as the
signed-in person. Anyone with `relay.terminal` on an OrbStack Mac can reach it
through the node's terminal, so treat that permission as their account on the
Mac too. Kiln doesn't use it.

Use another computer to view a Mac. Viewing a Mac from itself works, but it has
one pointer: moving it over the picture sends the Mac's pointer to the matching
place on the Mac, away from where you're looking, so clicks seem to go nowhere.

Screen Sharing listens on every network the Mac is on, not only for the Relay,
so anyone who can reach the Mac can try to sign in. Don't forward its port. Keep
macOS current too: before 26.6.1, 15.7.9 and 14.8.9, Screen Sharing had a bug
(CVE-2026-65400) that let anyone who could reach that port in without signing in.

The Relay runs in Docker, which normally starts when someone logs in, so a
restarted Mac can't be reached from Kiln until then. A Mac that sleeps drops off.

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
and audio frames. Whenever `VOXL_VERSION` changes, update that copy with its
`VERSION` file, and `KILN_DESKTOP_IMAGE_TAG`, which is `<voxl version>-<revision>`.
Raise `DESKTOP_IMAGE_REVISION` in `apps/desktop/Dockerfile` for any other change to
the image, as Relays keep the image a tag named. A test fails until they agree.
The **Desktop image** workflow publishes that tag from `main`. A nightly that gets
there first waits up to 20 minutes for the image and its source to be anonymously
pullable, then fails, and a stable release checks once.

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

## Monitors

Screen Sharing sends every display as one image and doesn't say where each one
is, so the Relay reads the arrangements macOS keeps in
`/Library/Preferences/com.apple.windowserver.displays.plist`, through its host
helper, and the page takes the one that fits the image. On Linux, `xrandr` says.

A backend reports monitors as rectangles of the image in `layouts`. The page
takes the arrangement whose size fits the image, reading it again when none does:
macOS saves a new one a few seconds after the displays change.

The page's `DesktopViewport` crops a client to a monitor by enlarging its element
and clipping it, so a client needs no support for it. With voxl it's only a crop:
the whole image is still sent. A client with `cropsMonitors` is sent just that
monitor instead, as on a Mac. Without a layout that fits, the picker stays hidden
and the page shows the whole image.

The accounts offered at sign-in are the folders in `/Users`, which the Relay
reads the same way, so they're suggestions. The page remembers the last account
that signed in, per Relay, in that browser, and never a password.

## Scaling a Mac's picture

macOS's server is the limit on a Mac. Whatever noVNC offers, it answers with ZRLE,
Zlib, or Raw, all lossless, at the displays' full size, and neither it nor VNC
can scale. A Retina display in motion cost about 5 MB an update, 100 ms on the Mac
to compress and 70 ms in the browser to decode, at about 5 updates a second.

So the Relay, next to the Mac, does it (`desktop-screen-scaling.ts`). After
sign-in it asks for Raw, which costs the Mac almost nothing and crosses to the
Docker VM at about 1 GB/s, and keeps the picture in memory. The page tells it which
part of the image to show and the size that fills the Desktop tab, and it
sends JPEG of that size. noVNC stays a plain VNC client: it sees a smaller
framebuffer and Tight rectangles, and the Relay maps its pointer back to the Mac.

```
Mac ──Raw, full size──▶ Relay ──JPEG, tab size──▶ browser
```

That brought a Retina display to 13 to 16 updates a second at about 100 KB each
with a video playing, and a 5120 × 2880 one to 9 to 16.

Moving pictures go out at lower quality and sharpen 250 ms after they stop, and
small changes such as typing go out sharp at once. Fetching and encoding overlap,
and at most one update waits between them, so nothing old queues up. Each is sent
once the browser asks, so a slow connection gets fewer updates, not late ones.
When the Mac's displays change it sends a new size. The Relay passes that on as a
desktop name, the one thing noVNC tells a page about, and the page asks again.

Each change is scaled apart from the rest of the picture, so it has to land on
the same pixels it would if everything were scaled together, or what's around it
shifts by a fraction of a pixel with every update. So the Relay scales in
sixteenths, where 16 of the Mac's pixels are a whole number of the viewer's,
rounding up from the tab's size, and sends whole 256-pixel tiles, which line up
JPEG's blocks too. A display that isn't a whole number of steps shows a thin
black edge of up to 15 of its pixels.

**Fast motion**, on by default, keeps every second pixel and row of a large
moving update before scaling it, a quarter of the work, where the picture is
scaled to half size or less. Small details shimmer while they move, and sharpen
when they stop.

**Lossless** on the toolbar sends every pixel at full size as PNG, for small text
and artwork, and moves much more slowly. It's for reading, not for watching.

`sharp` does the work, in the Relay's image only. It's Apache-2.0, and the libvips
it bundles is LGPL-3.0.

## Video on a Mac

Where it can, the Relay sends a Mac's picture as H.264 rather than JPEG. On a test
pattern changing every frame, that took a 3024 × 1964 image from about 20 updates
a second to about 37, at about 33 KB each, with the Relay no longer doing the
scaling.

```
Mac ──Raw, full size──▶ Relay ──what changed──▶ encoder
browser ◀──H.264, tab size── Relay ◀──H.264──────┘
```

x264 is under the GPL, so it stays out of the Relay's image. The encoder
(`apps/desktop/encoder.c`) is in the desktop image, and the Relay
(`desktop-video.ts`) starts it as `kiln-desktop-encoder`, on the way to a stream,
and removes it after 5 minutes unwatched. It runs as nobody on a read-only root,
with no capabilities or mounts and a process limit, in the Relay's network
namespace, listening on `127.0.0.1:47902` for a random token. It sees only pixels:
sign-in is over before a stream reaches it. Each viewer gets a connection and a
process of its own. Docker cleanup keeps the current desktop image, as a Mac would
otherwise lose video after a day nobody watched, and removes old ones.

The Relay still keeps the picture, and still fetches and sends in overlapping
stages. It sends the encoder only what changed, and the encoder keeps the whole
picture, scales it to the tab's size, and answers with a frame. A picture that
stops moving is encoded once more at a higher quality, so text ends up crisp.
Colour stays 4:2:0, so **Lossless** is still the way to read small coloured text.
Lossless stays PNG, and Fast motion leaves the toolbar, as it's about JPEG.

JPEG takes over for anything that can't do this: an encoder that can't start, one
that stops or stops answering mid-stream, and a browser that can't decode it. noVNC only offers H.264
if its own sample decodes, and that fails in Chrome on a Mac, so the page tries a
real frame from the encoder instead (`relay-desktop-video-check.ts`) and tells the
Relay in its view message. noVNC always holds a decoder, and plays what comes.

noVNC takes each slice for a whole frame, so the encoder uses one thread and one
slice. H.264 at level 5.1 stops at 9.4 million pixels, so a larger tab gets a
smaller picture, scaled up.

## Clipboard

voxl mirrors text and images itself, between the X clipboard and the browser.

A Mac ignores VNC's own clipboard messages in both directions, even after agreeing
to them, so the Relay uses the ones Apple's viewer does
(`desktop-mac-pasteboard.ts`), which work on the plain session noVNC opens. They
aren't documented: this was measured on macOS 27, and
[remotex](https://github.com/andrewtheguy/remotex/blob/HEAD/docs/apple-vnc-889.md)
has the protocol written up. After sign-in the Relay asks the Mac to say when its
pasteboard changes, and fetches it when it does. That's an archive of every
format of everything on it, so a line of text can come with megabytes of images.
The Relay keeps the text if there is any, as copying from a document brings a
picture of it too, and otherwise an image, and sends it to the page as cut text:
UTF-8, or PNG behind a marker. A browser's clipboard takes no other kind of image,
and Macs often keep theirs as TIFF, so `sharp` converts those. An archive over
64 MB is skipped, and text over 1 MB or an image over 15 MB stays where it is,
either way. An image pasted on the Mac isn't mirrored back.

Copied files stay out of this. All a Mac's clipboard holds of one is its path, and
a browser's can't hold a file at all. Kiln's host files are the way to move one.

Browsers guard their clipboards, so the page (`relay-desktop-clipboard.tsx`) works
with what each allows:

- What the Mac copies while the viewer's on the page is written to the browser's
  clipboard. That needs focus, and on phones a tap, so a refused write waits for
  the next one. Copies made while they're elsewhere are left, rather than replacing
  what they've copied there since.
- Paste on the viewer's keyboard is kept from noVNC, which would stop the browser's
  paste event. It lands in a hidden field, what was pasted goes to the Mac, and then
  the Mac gets the V. The Relay finishes with it before reading the next key. Text
  the Mac gave the browser stays out of this, so a file or rich text copied on the
  Mac still pastes as itself there. An image can't be told apart that way, as
  browsers re-encode them, so one copied and pasted on the Mac goes round as PNG.
  Something copied on the Mac that doesn't come here, such as a PDF, leaves the
  browser as it was: if that's text from the Mac, Paste gets the PDF, and otherwise
  it's what the viewer last copied that goes to the Mac.
- A touch screen has no paste key, so the toolbar has **Paste**.

The browser's clipboard only ever goes to the Mac on Paste. It's whatever the viewer
last copied, passwords included, so it isn't sent just for opening a desktop or
coming back to the tab. That means pasting from a menu on the Mac uses the Mac's own
clipboard until the viewer's pasted once. Anyone viewing gets what's copied on the
Mac, as they'd see it on screen.

## Stream recovery on a Mac

noVNC ends with the connection rather than retrying. The page shows why, and
Try again connects with the same session. A wrong password closes the
connection, so the page reconnects and asks again.

## Keyboard, fullscreen, and touch

On a Mac, macOS's server reads Alt and Super as Command, and only Meta as
Option, so the page sends a viewer's Alt or Option as Meta. Other computers' Control
is sent as Command, and their Windows key as Control, so shortcuts work by habit.

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
fingers scroll. voxl's toolbar adds an on-screen keyboard button, and on a Mac the
page's does: noVNC draws on a canvas, which can't open a phone's keyboard, so a
hidden text field takes the typing and the page sends what its text became, with
Shift around what needs it, as a keyboard would.

On a Mac, **Trackpad** on the toolbar moves the pointer by dragging, instead of
to where you touch, as a phone is too small to point at a desktop. It's on for
browsers whose main pointer is touch, and each browser remembers what it was set
to. The pointer starts in the middle. Tap clicks where it is, a double tap held
down drags, a long press or two-finger tap right-clicks, and two fingers scroll.
It's a layer over noVNC's canvas that sends it the mouse events it already takes
(`relay-desktop-trackpad.tsx`), so nothing about the stream changes.

There's no pinch zoom, and a physical monitor isn't resized to fit, so a 1080p desktop shows
at about a fifth of its size on a phone held upright.

## Licensing

voxl is MIT, but its binary links x264 (GPL-2.0), so the streamer image is
distributed under the GPL. It's a separate program in its own image, which
Kiln's images don't include: a Relay talks to it only over a socket, and pulls
it only when someone opens a desktop.

The GPL and LGPL ask that source be offered from the same place as the binary.
The source of every library the image adds to Debian's base image, x264 and
PulseAudio and all that they bring, ships inside it at the versions it installed,
so an update can't leave the two apart. Certificates and the OpenSSL they bring
aren't linked and are left out, and so is the base image, like those under Kiln's
other images: `debian-packages` lists its versions, and Debian's archive has their
source. voxl and the crates built into it are too large to ship inside, and a
version pins them exactly, so the **Desktop image** workflow publishes them as
`desktop:<tag>-source`, with `encoder.c`, an image of files rather than a
program, under `/src`. The streamer's image carries the licenses of voxl and those crates, and
the notices nested in them, such as the font voxl embeds. All of it is in
`/usr/share/doc/voxl`.

## Limits

- The stream always runs through Hearth, so its bitrate (up to 30 Mbps) counts
  against Hearth's bandwidth and adds a hop. Relays browsers can reach could
  take it directly.
- One display per node. Viewers share it, and all of them can type.
- A Mac's picture is scaled and encoded on the node's CPU, while someone watches,
  and each stream holds the whole area on show in memory, twice, or three times
  with video. Images over 60 million pixels aren't shown.
- voxl encodes on the CPU: about 1.5 cores on a busy desktop.
- A Mac has no sound. VNC doesn't carry any, a container can't hear the Mac, and
  Apple only sends it in High Performance mode, which shows a virtual display
  instead of the real ones, and sends UDP to the address on the connection, which
  through Docker is the Mac's own loopback.
