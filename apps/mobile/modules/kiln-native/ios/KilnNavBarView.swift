import ExpoModulesCore
import UIKit

/// UIKit's own tab bar, so the tabs get iOS's glass, its lens that follows a
/// finger across the items, and its rounded press. It reports where it laid
/// its items out, for the circle to line up with.
private final class SectionTabBar: UITabBar {
  var onItemsLayout: (([CGRect]) -> Void)?

  override func layoutSubviews() {
    super.layoutSubviews()
    // Pressing an item adds a magnified copy of the row for the glass lens.
    // Only views at their natural size are the items themselves.
    let frames = itemControls(in: self)
      .filter {
        let size = convert($0.bounds, from: $0).size
        return abs(size.width - $0.bounds.width) < 1 && abs(size.height - $0.bounds.height) < 1
      }
      .map { convert($0.bounds, from: $0) }
      .sorted { $0.minX < $1.minX }
    if !frames.isEmpty { onItemsLayout?(frames) }
  }

  override func safeAreaInsetsDidChange() {
    super.safeAreaInsetsDidChange()
    invalidateIntrinsicContentSize()
  }

  private func itemControls(in view: UIView) -> [UIView] {
    view.subviews.filter { !$0.isHidden }.flatMap { subview -> [UIView] in
      if subview is UIControl { return [subview] }
      return itemControls(in: subview)
    }
  }
}

/// The floating bottom bar: the app's tabs and a glass circle for the pages
/// of whatever is on screen. It reports taps by ID; JS decides what a tab
/// does (go to a page, or open its drawer) and which tab is selected.
final class KilnNavBarView: ExpoView, UITabBarDelegate {
  private static let labelFont = UIFont(name: "Geist-Medium", size: 11)
    ?? .systemFont(ofSize: 10, weight: .medium)
  private static let itemWidth: CGFloat = 92

  let onSelect = EventDispatcher()

  var sections: [NavSection] = [] { didSet { rebuildItems() } }
  var selectedSection: String? { didSet { showSelectedSection() } }
  var context: NavContext? { didSet { updateContext() } }
  var tint: UIColor = .systemOrange { didSet { tabBar.tintColor = tint } }
  var appearance = "dark" {
    didSet { overrideUserInterfaceStyle = appearance == "light" ? .light : .dark }
  }

  private let tabBar = SectionTabBar()
  private let contextButton = UIButton(type: .system)
  private lazy var tabBarWidth = tabBar.widthAnchor.constraint(equalToConstant: 0)
  private var contextVisible = false

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    overrideUserInterfaceStyle = .dark
    tabBar.delegate = self
    tabBar.itemPositioning = .fill
    // A phone-sized row of full items, whatever the window's size class.
    tabBar.traitOverrides.horizontalSizeClass = .compact
    tabBar.translatesAutoresizingMaskIntoConstraints = false
    addSubview(tabBar)
    NSLayoutConstraint.activate([
      tabBar.leadingAnchor.constraint(equalTo: leadingAnchor),
      tabBarWidth,
      tabBar.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])
    tabBar.onItemsLayout = { [weak self] frames in self?.placeContextButton(alongside: frames) }

    var config = UIButton.Configuration.glass()
    config.cornerStyle = .capsule
    config.baseForegroundColor = .label
    contextButton.configuration = config
    contextButton.isHidden = true
    contextButton.addAction(
      UIAction { [weak self] _ in self?.onSelect(["id": "context"]) }, for: .primaryActionTriggered
    )
    addSubview(contextButton)
  }

  // MARK: Layout

  private func placeContextButton(alongside frames: [CGRect]) {
    guard let first = frames.first, let last = frames.last else { return }
    let row = convert(first.union(last), from: tabBar)
    // The circle matches the bar's height and mirrors its inset on the right.
    let size = row.height + 8
    let inset = row.minX - 4
    contextButton.bounds = CGRect(x: 0, y: 0, width: size, height: size)
    contextButton.center = CGPoint(x: bounds.width - inset - size / 2, y: row.midY)
  }

  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    if contextVisible,
      let target = contextButton.hitTest(convert(point, to: contextButton), with: event)
    {
      return target
    }
    // Anywhere else that isn't the tab bar reaches the page beneath.
    return tabBar.hitTest(convert(point, to: tabBar), with: event)
  }

  // MARK: Tabs

  private func rebuildItems() {
    tabBarWidth.constant = Self.itemWidth * CGFloat(sections.count) + 20
    tabBar.items = sections.enumerated().map { index, section in
      let item = UITabBarItem(
        title: section.title,
        image: UIImage(systemName: section.systemImage),
        tag: index
      )
      item.setTitleTextAttributes([.font: Self.labelFont], for: .normal)
      item.setTitleTextAttributes([.font: Self.labelFont], for: .selected)
      return item
    }
    showSelectedSection()
  }

  private func showSelectedSection() {
    let item = sections.firstIndex { $0.id == selectedSection }.flatMap { tabBar.items?[$0] }
    if tabBar.selectedItem !== item { tabBar.selectedItem = item }
  }

  func tabBar(_ tabBar: UITabBar, didSelect item: UITabBarItem) {
    guard sections.indices.contains(item.tag) else { return }
    onSelect(["id": sections[item.tag].id])
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    showSelectedSection()
  }

  // MARK: Context

  private func updateContext() {
    guard let context else {
      setContextVisible(false)
      return
    }
    contextButton.configuration?.image = UIImage(
      systemName: context.systemImage,
      withConfiguration: UIImage.SymbolConfiguration(pointSize: 19, weight: .medium)
    )
    contextButton.accessibilityLabel = context.title
    setContextVisible(true)
  }

  private func setContextVisible(_ visible: Bool) {
    guard visible != contextVisible else { return }
    contextVisible = visible
    guard window != nil else {
      contextButton.isHidden = !visible
      return
    }
    let shrunk = CGAffineTransform(scaleX: 0.5, y: 0.5)
    if visible {
      contextButton.isHidden = false
      contextButton.alpha = 0
      contextButton.transform = shrunk
      UIView.animate(
        withDuration: 0.45, delay: 0, usingSpringWithDamping: 0.78,
        initialSpringVelocity: 0, options: [.beginFromCurrentState]
      ) {
        self.contextButton.alpha = 1
        self.contextButton.transform = .identity
      }
    } else {
      UIView.animate(
        withDuration: 0.22, delay: 0, options: [.beginFromCurrentState, .curveEaseIn]
      ) {
        self.contextButton.alpha = 0
        self.contextButton.transform = shrunk
      } completion: { _ in
        guard !self.contextVisible else { return }
        self.contextButton.isHidden = true
        self.contextButton.transform = .identity
      }
    }
  }
}
