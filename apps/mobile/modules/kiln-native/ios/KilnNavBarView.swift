import ExpoModulesCore
import UIKit

/// The floating bottom bar: a glass capsule of sections, each opening a menu
/// of its pages, and a separate glass circle whose menu holds the pages of
/// whatever is on screen. JS owns the state; the bar reports picks by ID.
final class KilnNavBarView: ExpoView {
  static let barHeight: CGFloat = 62
  private static let inset: CGFloat = 4
  private static let spacing: CGFloat = 12
  private static let labelFont = UIFont(name: "Geist-Medium", size: 11)
    ?? .systemFont(ofSize: 10, weight: .medium)

  let onSelect = EventDispatcher()

  var sections: [NavSection] = [] { didSet { rebuildSections() } }
  var selectedSection: String? { didSet { updateSelection(animated: window != nil) } }
  var context: NavContext? { didSet { updateContext() } }
  var tint: UIColor = .systemOrange { didSet { updateSelection(animated: false) } }
  var appearance = "dark" {
    didSet { overrideUserInterfaceStyle = appearance == "light" ? .light : .dark }
  }

  private let container = UIVisualEffectView()
  private let capsule = UIVisualEffectView()
  private let circle = UIVisualEffectView()
  private let indicator = UIView()
  private let contextButton = UIButton(type: .system)
  private var sectionButtons: [UIButton] = []
  private var itemWidth: CGFloat = 80
  private var effectsInstalled = false
  private var contextVisible = false

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    overrideUserInterfaceStyle = .dark
    addSubview(container)
    container.contentView.addSubview(capsule)
    container.contentView.addSubview(circle)

    for view in [capsule, circle] {
      view.clipsToBounds = true
      view.layer.cornerCurve = .continuous
    }
    indicator.isUserInteractionEnabled = false
    indicator.layer.cornerCurve = .continuous
    indicator.backgroundColor = UIColor { traits in
      traits.userInterfaceStyle == .dark
        ? UIColor.white.withAlphaComponent(0.1)
        : UIColor.black.withAlphaComponent(0.06)
    }
    capsule.contentView.addSubview(indicator)

    contextButton.showsMenuAsPrimaryAction = true
    contextButton.preferredMenuElementOrder = .fixed
    // The button joins the circle only while it shows: the glass container
    // otherwise keeps a hidden button reachable by accessibility.
    circle.isHidden = true
  }

  // MARK: Glass

  private var glassAvailable: Bool {
    #if compiler(>=6.2)
    if #available(iOS 26.0, *) {
      return NSClassFromString("UIGlassEffect") != nil
    }
    #endif
    return false
  }

  private func makeEffect() -> UIVisualEffect {
    #if compiler(>=6.2)
    if #available(iOS 26.0, *), glassAvailable {
      let glass = UIGlassEffect(style: .regular)
      glass.isInteractive = true
      return glass
    }
    #endif
    return UIBlurEffect(style: .systemChromeMaterial)
  }

  /// UIKit skips glass on a view that isn't in a window yet and never
  /// installs it later, so the effects go on once the bar is on screen.
  private func installEffects() {
    guard !effectsInstalled, window != nil else { return }
    effectsInstalled = true
    #if compiler(>=6.2)
    if #available(iOS 26.0, *), glassAvailable {
      let merge = UIGlassContainerEffect()
      merge.spacing = Self.spacing
      container.effect = merge
    }
    #endif
    if !glassAvailable {
      for view in [capsule, circle] {
        view.layer.borderWidth = 1 / max(traitCollection.displayScale, 1)
        view.layer.borderColor = UIColor.separator.cgColor
      }
    }
    capsule.effect = makeEffect()
    // Glass materializes when the circle appears; blur stays and fades.
    if contextVisible || !glassAvailable { circle.effect = makeEffect() }
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    installEffects()
  }

  // MARK: Layout

  override func layoutSubviews() {
    super.layoutSubviews()
    container.frame = bounds
    let height = Self.barHeight
    let top = bounds.height - height
    let capsuleWidth = Self.inset * 2 + itemWidth * CGFloat(sectionButtons.count)
    capsule.frame = CGRect(x: 0, y: top, width: capsuleWidth, height: height)
    capsule.layer.cornerRadius = height / 2
    for (index, button) in sectionButtons.enumerated() {
      button.frame = CGRect(
        x: Self.inset + itemWidth * CGFloat(index),
        y: Self.inset,
        width: itemWidth,
        height: height - Self.inset * 2
      )
    }
    // Bounds and center, not frame: the circle scales as it appears.
    circle.bounds = CGRect(x: 0, y: 0, width: height, height: height)
    circle.center = CGPoint(x: bounds.width - height / 2, y: top + height / 2)
    circle.layer.cornerRadius = height / 2
    contextButton.frame = circle.bounds
    placeIndicator()
    installEffects()
  }

  override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
    // Between the capsule and the circle, touches reach the page beneath.
    capsule.frame.contains(point) || (contextVisible && circle.frame.contains(point))
  }

  // MARK: Sections

  private func rebuildSections() {
    sectionButtons.forEach { $0.removeFromSuperview() }
    let widest = sections.map {
      ($0.title as NSString).size(withAttributes: [.font: Self.labelFont]).width
    }.max() ?? 0
    itemWidth = max(76, ceil(widest) + 36)
    sectionButtons = sections.map(makeSectionButton)
    sectionButtons.forEach(capsule.contentView.addSubview)
    setNeedsLayout()
    updateSelection(animated: false)
  }

  private func makeSectionButton(_ section: NavSection) -> UIButton {
    var config = UIButton.Configuration.plain()
    config.image = UIImage(
      systemName: section.systemImage,
      withConfiguration: UIImage.SymbolConfiguration(pointSize: 17, weight: .medium)
    )
    config.imagePlacement = .top
    config.imagePadding = 4
    config.title = section.title
    config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer {
      var attributes = $0
      attributes.font = Self.labelFont
      return attributes
    }
    config.contentInsets = .zero
    let button = UIButton(configuration: config)
    button.showsMenuAsPrimaryAction = true
    button.preferredMenuElementOrder = .fixed
    button.menu = menu(title: section.menuTitle, items: section.items)
    button.accessibilityLabel = section.title
    button.accessibilityValue = section.items.first(where: \.selected)?.title
    return button
  }

  private func updateSelection(animated: Bool) {
    for (index, button) in sectionButtons.enumerated() {
      let selected = sections[index].id == selectedSection
      button.configuration?.baseForegroundColor = selected ? tint : .label
      if selected {
        button.accessibilityTraits.insert(.selected)
      } else {
        button.accessibilityTraits.remove(.selected)
      }
    }
    if animated {
      UIView.animate(
        withDuration: 0.4, delay: 0, usingSpringWithDamping: 0.82,
        initialSpringVelocity: 0, options: [.beginFromCurrentState]
      ) { self.placeIndicator() }
    } else {
      placeIndicator()
    }
  }

  private func placeIndicator() {
    guard
      let index = sections.firstIndex(where: { $0.id == selectedSection }),
      index < sectionButtons.count
    else {
      indicator.alpha = 0
      return
    }
    let frame = sectionButtons[index].frame
    indicator.frame = frame
    indicator.layer.cornerRadius = frame.height / 2
    indicator.alpha = 1
  }

  // MARK: Context

  private func updateContext() {
    guard let context, !context.items.isEmpty else {
      setContextVisible(false)
      return
    }
    var config = UIButton.Configuration.plain()
    config.image = UIImage(
      systemName: context.systemImage,
      withConfiguration: UIImage.SymbolConfiguration(pointSize: 19, weight: .medium)
    )
    config.baseForegroundColor = .label
    contextButton.configuration = config
    contextButton.menu = menu(title: context.title, items: context.items)
    contextButton.accessibilityLabel = "\(context.title) pages"
    contextButton.accessibilityValue = context.items.first(where: \.selected)?.title
    setContextVisible(true)
  }

  private func setContextVisible(_ visible: Bool) {
    guard visible != contextVisible else { return }
    contextVisible = visible
    guard effectsInstalled else {
      circle.isHidden = !visible
      attachContextButton(visible)
      return
    }
    let shrunk = CGAffineTransform(scaleX: 0.5, y: 0.5)
    if visible {
      circle.isHidden = false
      attachContextButton(true)
      circle.transform = shrunk
      contextButton.alpha = 0
      if !glassAvailable { circle.alpha = 0 }
      UIView.animate(
        withDuration: 0.45, delay: 0, usingSpringWithDamping: 0.78,
        initialSpringVelocity: 0, options: [.beginFromCurrentState]
      ) {
        // Animating the effect itself is how glass materializes.
        if self.glassAvailable { self.circle.effect = self.makeEffect() } else { self.circle.alpha = 1 }
        self.circle.transform = .identity
        self.contextButton.alpha = 1
      }
    } else {
      UIView.animate(
        withDuration: 0.25, delay: 0, options: [.beginFromCurrentState, .curveEaseIn]
      ) {
        if self.glassAvailable { self.circle.effect = nil } else { self.circle.alpha = 0 }
        self.circle.transform = shrunk
        self.contextButton.alpha = 0
      } completion: { _ in
        guard !self.contextVisible else { return }
        self.circle.isHidden = true
        self.attachContextButton(false)
        self.circle.transform = .identity
      }
    }
  }

  private func attachContextButton(_ attached: Bool) {
    if attached {
      guard contextButton.superview == nil else { return }
      circle.contentView.addSubview(contextButton)
      contextButton.frame = circle.bounds
    } else {
      contextButton.removeFromSuperview()
    }
  }

  // MARK: Menus

  private func menu(title: String, items: [NavItem]) -> UIMenu {
    UIMenu(
      title: title,
      children: items.map { item in
        UIAction(
          title: item.title,
          image: UIImage(systemName: item.systemImage),
          state: item.selected ? .on : .off
        ) { [weak self] _ in
          self?.onSelect(["id": item.id])
        }
      }
    )
  }
}
