# Kiln mobile (prototype)

An Expo (SDK 58, React Native 0.88) app for iOS and Android that watches and
controls a Hearth from a phone: game servers, Relays, power, a live console,
and activity.

It talks to Hearth's CLI API (`/api/cli/v1/*`) with a CLI credential. To get
one, the app opens Hearth's `/mobile/sign-in` page in a private browser sheet,
you sign in there as you would in the browser, and Hearth sends the sheet back
to `kiln://auth` with a one-time code. The app trades that code, with a
verifier it never sent anywhere (only its SHA-256 went out with the sign-in),
at `/api/cli/auth/mobile/token`. The bearer token lands in the iOS Keychain or
Android Keystore through `expo-secure-store`. The phone shows in Hearth with
your linked CLIs and is unlinked the same way.

## Layout

| Path                                           | What                                                      |
| ---------------------------------------------- | --------------------------------------------------------- |
| `app.config.ts`                                | App name, bundle ID, fonts, splash, ATS                   |
| `metro.config.js`                              | Monorepo watch, workspace sources, Uniwind                |
| `global.css`                                   | Hearth's palette as Uniwind (Tailwind 4) theme tokens     |
| `src/App.tsx`                                  | Providers, the native stack, and the header               |
| `src/navigation.ts`                            | Routes and Hearth's Infra, Manage and game server pages   |
| `src/components/NavBar.tsx`                    | The floating bar: Home, Infra, Manage and the page circle |
| `modules/kiln-native/`                         | The bar's UIKit view: iOS's tab bar and a glass button    |
| `src/menus.ts`, `src/screens/DrawerScreen.tsx` | The drawers the bar opens                                 |
| `src/api/hearth.ts`                            | Effect-based fetch client and `HearthError`               |
| `src/api/sign-in.ts`                           | Sign-in through Hearth's page in a browser sheet          |
| `src/api/queries.ts`                           | TanStack Query hooks; polling only while a screen is open |
| `src/api/console.ts`                           | Console history plus NDJSON follow stream (`expo/fetch`)  |
| `src/session/`                                 | Session in secure storage, sign-in state                  |
| `src/screens/`, `src/components/ui.tsx`        | Screens and shared primitives                             |

Response shapes come from `@workspace/contracts/cli`, the same zod schemas the
CLI uses, so a contract change breaks the app's typecheck rather than its
runtime.

## Run it

The app needs iOS 27 or later: its navigation is iOS's liquid glass tab bar
and sheets, with no fallback for older versions.

Prerequisites: Xcode 27 (with an iOS 27 simulator runtime) and CocoaPods
(`brew install cocoapods watchman`). Watchman keeps Metro source watching
reliable across large worktrees. Use `vp install` from the repository root.

```sh
cd apps/mobile
npx expo prebuild --platform ios   # generates ./ios from app.config.ts
npx expo run:ios                   # builds, installs on a simulator, starts Metro
```

To reach a dev Hearth from the simulator, use `http://localhost:<port>`. For a
phone, share the stack over Tailscale (see the `shareable-url` skill) and
enter the `https://<machine>.<tailnet>.ts.net:<port>` URL in the app.
`kiln://connect?url=<hearth>` fills in the URL and starts sign-in:

```sh
xcrun simctl openurl booted "kiln://connect?url=http://localhost:3000"
```

### On an iPhone without a paid Apple developer account

A free Apple ID works; apps it signs run for 7 days before they need a
rebuild.

1. Xcode → Settings → Accounts → **+** → sign in with your Apple ID.
2. Connect the iPhone over USB, tap **Trust**, then enable
   Settings → Privacy & Security → **Developer Mode** and restart.
3. Set your team, and your own bundle ID if the default is taken (free
   teams can't share one), before prebuilding:

   ```sh
   export KILN_IOS_TEAM_ID=ABCDE12345          # Xcode → Settings → Accounts
   export KILN_IOS_BUNDLE_ID=com.yourname.kiln
   ```

4. Build a standalone Release app, which runs without Metro:

   ```sh
   npx expo prebuild --platform ios --clean
   npx expo run:ios --device --configuration Release
   ```

   Pick your phone when asked. Without `KILN_IOS_TEAM_ID`, choose the team
   in Xcode instead: open `ios/Kiln.xcworkspace`, select the **Kiln** target
   → Signing & Capabilities, and pick your Personal Team.

5. On the phone, trust the developer profile: Settings → General → VPN &
   Device Management → your Apple ID → **Trust**.

For a debug build that live-reloads from Metro, drop `--configuration
Release`; the phone must reach this Mac on the network.

## Not yet

- Several Hearths at once (one session key today).
- Apps and databases: the CLI API has no endpoints for them yet.
- Live state over `/api/realtime`, which takes only cookie sessions; the app
  polls instead.
- Push notifications, which a free Apple account can't sign.

### Kiln Dev: Fast Refresh over Tailscale

`Kiln Dev` installs beside standalone `Kiln` with bundle ID
`gg.quartzdev.kiln.mobile.dev` and scheme `kiln-dev`. Build it once:

```sh
cd apps/mobile
APP_VARIANT=development KILN_IOS_TEAM_ID=<your-team> pnpm exec expo prebuild --platform ios
pnpm ios:dev
```

Start Metro from the checkout you want to work on:

```sh
pnpm dev:tailscale
```

The command checks Tailscale, binds Metro to loopback on port 8082, and creates
an HTTPS Serve listener on 8482. It refuses to replace another service. It
prints a QR code/deep link for Kiln Dev; open that link on the phone, or enter
the printed HTTPS URL in the development client's launcher. The launcher
remembers recent projects. No Expo account, public tunnel, shared Wi-Fi, or
USB cable is needed after installation. Both devices must be connected to the
same tailnet. The command prevents idle sleep on macOS while Metro runs;
keep the Mac powered on and its lid open.

React/TypeScript and styling changes Fast Refresh on save. Branch switches
in the same checkout use the same URL; reload the project after switching.
Install that branch's dependencies first. For concurrent worktrees, start
another Metro with a different free pair of ports:

```sh
METRO_PORT=8083 METRO_HTTPS_PORT=8483 pnpm dev:tailscale
```

Open its printed link to switch the same Kiln Dev app to that checkout.
Different branches don't need different apps when their native dependencies
and native configuration match. Swift changes (including the custom bar),
Expo SDK upgrades, or adding/removing native modules require rebuilding and
installing Kiln Dev from that branch. Two incompatible native versions tested
at once would need separate app variants.

The default Tailscale HTTPS port **8482** is reserved for Kiln Metro. Stopping
Metro leaves its Serve listener in place, so other previews see the port as
occupied. While Metro is stopped the URL returns a gateway error; start the
command again to reconnect. Metro itself uses loopback port **8082**. The URL
is remembered by Kiln Dev, rather than compiled into the app. Use `pnpm dev` for ordinary LAN development. To build
standalone Kiln again, regenerate without `APP_VARIANT=development` before
using `pnpm ios:release`.
