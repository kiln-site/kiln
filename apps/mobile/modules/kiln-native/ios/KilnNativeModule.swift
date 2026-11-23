import ExpoModulesCore
import UIKit

/// A tab: it either goes to a page or opens its drawer, as JS decides.
struct NavSection: Record {
  @Field var id: String = ""
  @Field var title: String = ""
  @Field var systemImage: String = ""
}

/// The circle beside the tabs, for the pages of what's on screen.
struct NavContext: Record {
  @Field var title: String = ""
  @Field var systemImage: String = ""
}

public final class KilnNativeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("KilnNative")

    View(KilnNavBarView.self) {
      ViewName("NavBar")
      Events("onSelect")
      Prop("sections") { (view: KilnNavBarView, value: [NavSection]) in
        view.sections = value
      }
      Prop("selectedSection") { (view: KilnNavBarView, value: String?) in
        view.selectedSection = value
      }
      Prop("context") { (view: KilnNavBarView, value: NavContext?) in
        view.context = value
      }
      Prop("tint") { (view: KilnNavBarView, value: UIColor) in
        view.tint = value
      }
      Prop("appearance") { (view: KilnNavBarView, value: String) in
        view.appearance = value
      }
    }
  }
}
