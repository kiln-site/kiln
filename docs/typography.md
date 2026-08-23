# Hearth typography

Hearth is an operational interface for people running self-hosted servers. Its
typography should make dense state easy to scan without making labels, help
text, or actions feel miniature. Geist carries interface copy and JetBrains
Mono is reserved for values whose technical shape matters.

## Roles

Use the semantic class for a role instead of composing an arbitrary font size,
line height, weight, and tracking value at each call site.

| Role            | Class                  |          Mobile size | Intended use                                       |
| --------------- | ---------------------- | -------------------: | -------------------------------------------------- |
| Display         | `type-display`         |                 32px | Auth, legal, and exceptional empty/error moments   |
| Page title      | `type-page-title`      | 20px, 24px from `sm` | Global page toolbar title                          |
| Page context    | `type-page-context`    | 16px, 18px from `sm` | Route context beside a page title                  |
| Dialog title    | `type-dialog-title`    |                 20px | Modal and sheet titles                             |
| Section title   | `type-section-title`   |                 16px | Major sections within a page                       |
| Card title      | `type-card-title`      |                 14px | Cards, panels, and compact subsection titles       |
| Body            | `type-body`            |                 14px | Default product copy                               |
| Supporting copy | `type-support`         |                 13px | Descriptions, hints, and empty-state guidance      |
| Menu item       | `type-menu`            |                 14px | Navigation, dropdown, select, and combobox options |
| Control         | `type-control`         |                 14px | Buttons, selects, and primary interactive labels   |
| Compact control | `type-control-sm`      |                 13px | Deliberately compact controls                      |
| Input           | `type-input`           | 16px, 14px from `md` | Inputs and textareas; 16px prevents mobile zoom    |
| Label           | `type-label`           |                 12px | Form labels and concise secondary headings         |
| Metadata        | `type-meta`            |                 12px | Dates, counts, IDs, and passive supporting values  |
| Technical label | `type-technical-label` |                 12px | Uppercase table headings and operational eyebrows  |
| Inline code     | `type-code`            |                 13px | Commands, paths, IDs, and short technical values   |

The root rem continues to scale on large displays. Sizes above describe the
16px root used on mobile; existing viewport scaling raises them together on
larger screens.

## Color and contrast

- Use `text-foreground` for titles, primary copy, values, and active controls.
- Use `text-muted-foreground` for supporting copy, labels, and metadata.
- Use semantic status colors such as `text-primary` and `text-destructive` only
  when the text communicates that status.
- Do not add alpha to readable muted text. `text-muted-foreground/70`, nested
  opacity, and similar combinations lose contrast in the light theme.
- Opacity communicates state only: disabled, unavailable, transitioning, or
  intentionally hidden. It must not create ordinary hierarchy.
- Icons and decorative marks may use lower opacity when they do not carry
  information by themselves.

## Composition rules

- The ordinary product floor is 12px. Anything smaller must be nonessential
  data-plane content in an explicitly documented specialist surface.
- Prefer sentence case. `type-technical-label` owns the tracked uppercase
  treatment; do not recreate it with arbitrary mono, size, and tracking values.
- Use approximately 1.5 line height for body and supporting copy and 1.2–1.35
  for headings, labels, and controls.
- Limit long prose to roughly `65ch`. Tables, navigation, editors, and console
  output are not prose and should use the space their task requires.
- Semantic heading levels describe document structure. Choose their visual role
  with the typography classes instead of assuming every `h2` looks alike.

## Specialist surfaces

Specialist surfaces use the product roles for their surrounding chrome and keep
smaller sizes only where density is intrinsic to the data plane:

| Surface               | Exception                                        |
| --------------------- | ------------------------------------------------ |
| Console output        | 11px log rows and 9px nonessential timestamps    |
| Chart plotting region | 10px axis ticks and reference labels             |
| Code editor           | User-controlled content size with a 16px default |

Console filters, warnings and actions; file-tree metadata and menus; file-viewer
toolbars; and chart legends and tooltips use the product roles. These exceptions
should not be copied into ordinary components or expanded without a documented
density requirement.

## Example

```tsx
<section aria-labelledby={headingId}>
  <h2 id={headingId} className="type-section-title text-foreground">
    Network allocation
  </h2>
  <p className="type-support text-muted-foreground">
    Choose the addresses this server can publish.
  </p>
</section>
```
