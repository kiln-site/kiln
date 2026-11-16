# Kiln mobile (prototype)

An Expo (SDK 58, React Native 0.88) app for iOS and Android that watches and
controls a Hearth from a phone: game servers, Relays, power, a live console,
and activity.

It talks to Hearth's CLI API (`/api/cli/v1/*`) with the CLI's own sign-in.
The app asks Hearth for a device code, you approve it on Hearth's
`/cli/authorize` page in the browser sheet, and the bearer token lands in the
iOS Keychain or Android Keystore through `expo-secure-store`. Hearth needs no
changes for this: the device appears in Hearth with the CLI credentials and is
revoked the same way.

## Layout

| Path                         | What                                                      |
| ---------------------------- | --------------------------------------------------------- |
| `app.config.ts`              | App name, bundle ID, fonts, splash, ATS                   |
| `metro.config.js`            | Monorepo watch, workspace sources, Uniwind                |
| `global.css`                 | Hearth's palette as Uniwind (Tailwind 4) theme tokens     |
| `src/App.tsx`                | Providers and the static native-stack navigator           |
| `src/api/hearth.ts`          | Effect-based fetch client and `HearthError`               |
| `src/api/device-login.ts`    | Device-code sign-in                                       |
| `src/api/queries.ts`         | TanStack Query hooks; polling only while a screen is open |
| `src/api/console.ts`         | Console history plus NDJSON follow stream (`expo/fetch`)  |
| `src/session/`               | Session in secure storage, sign-in state                  |
| `src/screens/`, `src/components/ui.tsx` | Screens and shared primitives                  |

Response shapes come from `@workspace/contracts/cli`, the same zod schemas the
CLI uses, so a contract change breaks the app's typecheck rather than its
runtime.

## Run it

Prerequisites: Xcode (with an iOS simulator runtime) and CocoaPods
(`brew install cocoapods`). Use `vp install` from the repository root.

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
