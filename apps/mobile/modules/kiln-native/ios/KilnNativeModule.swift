import ExpoModulesCore
import UIKit

struct NavItem: Record {
  @Field var id: String = ""
  @Field var title: String = ""
  @Field var systemImage: String = ""
  @Field var selected: Bool = false
}

struct NavSection: Record {
  @Field var id: String = ""
  @Field var title: String = ""
  @Field var menuTitle: String = ""
  @Field var systemImage: String = ""
  @Field var items: [NavItem] = []
}

struct NavContext: Record {
  @Field var title: String = ""
  @Field var systemImage: String = ""
  @Field var items: [NavItem] = []
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
