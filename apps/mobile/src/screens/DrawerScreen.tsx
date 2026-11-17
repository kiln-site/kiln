import { useNavigation, type StaticScreenProps } from "@react-navigation/native"
import * as Haptics from "expo-haptics"
import type { ReactElement } from "react"

import { DrawerRow, DrawerSheet } from "../components/drawer"
import {
  contentRouteOf,
  drawerFor,
  openDrawerItem,
  type DrawerKind,
} from "../menus"

type Props = StaticScreenProps<{ readonly kind: DrawerKind }>

/** A native sheet of pages that slides up from the bar. */
export function DrawerScreen({ route }: Props): ReactElement {
  const navigation = useNavigation()
  const content = contentRouteOf(navigation.getState())
  const drawer = content ? drawerFor(route.params.kind, content) : null

  return (
    <DrawerSheet title={drawer?.title}>
      {content && drawer
        ? drawer.items.map((item) => (
            <DrawerRow
              key={item.id}
              symbol={item.symbol}
              label={item.title}
              selected={item.selected}
              onPress={() => {
                void Haptics.selectionAsync()
                openDrawerItem(navigation, content, item.id)
              }}
            />
          ))
        : null}
    </DrawerSheet>
  )
}
