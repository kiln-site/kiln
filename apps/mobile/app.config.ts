import type { ConfigContext, ExpoConfig } from "expo/config"

// Free Apple "Personal Team" signing needs a bundle identifier no one else has
// registered. Set KILN_IOS_BUNDLE_ID (for example com.yourname.kiln) before
// `expo prebuild` when the default is taken.
const bundleIdentifier =
  process.env.KILN_IOS_BUNDLE_ID?.trim() || "gg.quartzdev.kiln.mobile"
// Your Apple team ID (a free Personal Team works), written into the Xcode
// project so `expo run:ios --device` can sign without opening Xcode. Find it
// in Xcode → Settings → Accounts, or in the error the first build prints.
const appleTeamId = process.env.KILN_IOS_TEAM_ID?.trim() || undefined

const font = (pkg: string, file: string) =>
  `node_modules/@expo-google-fonts/${pkg}/${file.split("_")[1]}/${file}.ttf`

const fonts = [
  {
    family: "Geist-Regular",
    file: font("geist", "Geist_400Regular"),
    weight: 400,
  },
  {
    family: "Geist-Medium",
    file: font("geist", "Geist_500Medium"),
    weight: 500,
  },
  {
    family: "Geist-SemiBold",
    file: font("geist", "Geist_600SemiBold"),
    weight: 600,
  },
  {
    family: "JetBrainsMono-Regular",
    file: font("jetbrains-mono", "JetBrainsMono_400Regular"),
    weight: 400,
  },
  {
    family: "JetBrainsMono-Medium",
    file: font("jetbrains-mono", "JetBrainsMono_500Medium"),
    weight: 500,
  },
]

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "Kiln",
  slug: "kiln",
  scheme: "kiln",
  version: "0.0.1",
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "automatic",
  backgroundColor: "#12100f",
  experiments: { reactCompiler: true },
  ios: {
    bundleIdentifier,
    appleTeamId,
    supportsTablet: true,
    infoPlist: {
      // Self-hosted Hearths are often reached over plain HTTP on a LAN or a
      // tailnet, so allow it and explain local network access.
      NSAppTransportSecurity: { NSAllowsArbitraryLoads: true },
      NSLocalNetworkUsageDescription:
        "Kiln connects to your Hearth on your local network or tailnet.",
      ITSAppUsesNonExemptEncryption: false,
    },
  },
  android: {
    package: bundleIdentifier,
    adaptiveIcon: {
      foregroundImage: "./assets/adaptive-icon.png",
      backgroundColor: "#12100f",
    },
  },
  plugins: [
    "expo-secure-store",
    "expo-web-browser",
    [
      "expo-font",
      {
        ios: { fonts: fonts.map((entry) => entry.file) },
        android: {
          fonts: fonts.map((entry) => ({
            fontFamily: entry.family,
            fontDefinitions: [{ path: entry.file, weight: entry.weight }],
          })),
        },
      },
    ],
    [
      "expo-splash-screen",
      {
        image: "./assets/splash-icon.png",
        imageWidth: 120,
        resizeMode: "contain",
        backgroundColor: "#f0e8e3",
        dark: { image: "./assets/splash-icon.png", backgroundColor: "#12100f" },
      },
    ],
    [
      "expo-build-properties",
      {
        ios: { deploymentTarget: "17.0" },
        android: { usesCleartextTraffic: true },
      },
    ],
  ],
})
