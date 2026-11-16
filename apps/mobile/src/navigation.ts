// Declared by hand rather than inferred from the static navigator: screens
// navigate by these names, and inferring them from App.tsx would make every
// screen's type depend on the navigator that renders it.
export type RootStackParamList = {
  Connect: undefined
  Home: undefined
  Server: { relayId: string; instanceId: string; name: string }
  Console: { relayId: string; instanceId: string; name: string }
  Relay: { relayId: string; name: string }
  Activity: undefined
  Account: undefined
}

declare global {
  namespace ReactNavigation {
    interface RootParamList extends RootStackParamList {}
  }
}
