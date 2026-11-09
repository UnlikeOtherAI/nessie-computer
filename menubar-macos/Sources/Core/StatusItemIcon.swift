import AppKit

/// The mark in the menu bar.
///
/// It is the executor's own plus (`assets/logo/nessie-executor-mark.svg`) — the
/// same mark the Windows tray shows beside the clock, so one machine's executor
/// looks like the same product on either operating system. It is not a system
/// glyph: the first version of this app drew `circle.dashed` and an
/// `exclamationmark.triangle`, and among fifteen other status items that read as
/// a loading spinner belonging to nobody — a person told us they could not find
/// the icon at all. Three rules came out of that, and all three are asserted
/// below:
///
/// 1. **Always the same mark, always filled.** Every state draws the same plus
///    and every state fills it. An earlier version stroked it instead, and
///    `markPath` is a composite of two crossing bars, so stroking outlined
///    *every* subpath — including the interior edges where the bars meet. At
///    18pt the mark dissolved into hairline loops. A stroked composite path can
///    never be the union outline; only a fill is.
/// 2. **State is said by tint and by a badge, not by a different picture.**
///    Idle is the same mark at a lower tint. Needs you is the mark plus a
///    dot, and it is the one state that moves: the mark steps aside by about a
///    sixth so the badge gets a corner of its own, because a dot laid over the
///    mark reads as part of it rather than as a badge.
/// 3. **Always a template image.** A template is masked and tinted by the system,
///    which is the only way an icon is legible on a light menu bar, a dark one,
///    a tinted desktop behind a translucent bar, and in Reduce Transparency.
///    It is also why the menu bar gets the plus's silhouette rather than its
///    four brand colours: the system draws a template in one tint, and a
///    coloured status item is the unreadable-on-a-tinted-bar defect above.
public enum StatusItemIcon {
    /// The menu bar's usable height is 22pt; 18pt is Apple's guidance for the
    /// drawn mark, which leaves the item its own breathing room.
    public static let size = NSSize(width: 18, height: 18)

    /// `description` is what VoiceOver says; the menu passes its own
    /// status-derived sentence in the person's language.
    public static func image(for icon: MenuIcon, description: String? = nil) -> NSImage {
        let image = NSImage(size: size, flipped: false) { rect in
            draw(icon, in: rect)
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = description
        return image
    }

    private static func draw(_ icon: MenuIcon, in rect: NSRect) {
        switch icon {
        case .working:
            NSColor.black.set()
            markPath(in: rect).fill()
        case .idle:
            // The same silhouette at a lower tint. This was a stroked composite
            // path, which outlines every subpath — including the interior edges
            // where the two bars cross — so at 18pt the mark dissolved into
            // hairline loops nobody could read as one shape.
            NSColor.black.withAlphaComponent(0.35).set()
            markPath(in: rect).fill()
        case .needsYou:
            // The badge gets its own corner rather than sitting on the
            // letterform: the mark steps aside, the dot takes the space, and
            // the cleared ring is what makes it read as a badge in one tint.
            let diameter = rect.width * 0.30
            let markBox = NSRect(
                x: rect.minX,
                y: rect.minY + diameter * 0.55,
                width: rect.width - diameter * 0.55,
                height: rect.height - diameter * 0.55
            )
            NSColor.black.set()
            markPath(in: markBox).fill()
            // The badge is cleared out of the mark first, then drawn, so the
            // ring around it is transparent rather than a second tint — the one
            // way a dot reads as a badge on a bar that may be any colour.
            let badge = NSRect(x: rect.maxX - diameter, y: rect.minY, width: diameter, height: diameter)
            NSGraphicsContext.current?.compositingOperation = .clear
            NSBezierPath(ovalIn: badge.insetBy(dx: -diameter * 0.28, dy: -diameter * 0.28)).fill()
            NSGraphicsContext.current?.compositingOperation = .sourceOver
            NSColor.black.set()
            NSBezierPath(ovalIn: badge).fill()
        }
    }

    /// The executor plus, as the two crossing bars it is built from. The numbers
    /// are the mark's own, read off `assets/logo/nessie-executor-mark.svg` in the
    /// 1254-unit space the brand artwork is drawn in, so the menu bar and the
    /// Windows tray scale one geometry instead of two drawings that drift.
    ///
    /// The colour split the SVG carries is deliberately not reproduced: a
    /// template image is one tint by definition (rule 3), and the silhouette is
    /// the whole of what a menu bar can show.
    private static let markBounds = NSRect(x: 35, y: 35, width: 1184, height: 1184)

    /// Half the bar's width, which is also its cap radius: the arms end in
    /// semicircles, so the rounded rect's radius is exactly half its short side.
    private static let barHalfWidth: CGFloat = 155

    private static func markPath(in rect: NSRect) -> NSBezierPath {
        let inset = rect.insetBy(dx: 1.5, dy: 1.0)
        let scale = min(inset.width / markBounds.width, inset.height / markBounds.height)
        let drawn = NSSize(width: markBounds.width * scale, height: markBounds.height * scale)
        let origin = NSPoint(
            x: inset.midX - drawn.width / 2,
            y: inset.midY - drawn.height / 2
        )

        // The SVG's y grows downward; AppKit's grows upward, so every y is
        // mirrored inside the mark's own box rather than by flipping the context.
        func point(_ horizontal: CGFloat, _ vertical: CGFloat) -> NSPoint {
            NSPoint(
                x: origin.x + (horizontal - markBounds.minX) * scale,
                y: origin.y + (markBounds.maxY - vertical) * scale
            )
        }
        /// One arm of the plus. The radius is half the *short* side, so the
        /// horizontal bar rounds on its height and the vertical one on its
        /// width; taking `width / 2` for both would round the long bar into a
        /// lozenge the width of the whole mark.
        func bar(left: CGFloat, right: CGFloat, top: CGFloat, bottom: CGFloat) -> NSBezierPath {
            let topLeft = point(left, top)
            let bottomRight = point(right, bottom)
            let box = NSRect(
                x: topLeft.x,
                y: bottomRight.y,
                width: bottomRight.x - topLeft.x,
                height: topLeft.y - bottomRight.y
            )
            let radius = min(box.width, box.height) / 2
            return NSBezierPath(roundedRect: box, xRadius: radius, yRadius: radius)
        }

        let centre: CGFloat = 627
        let near = centre - barHalfWidth
        let far = centre + barHalfWidth

        // Two stadiums crossing at the centre. They overlap, and a non-zero
        // winding fill of both is their union — which is the whole reason this
        // is one filled composite path rather than two stroked outlines.
        let path = NSBezierPath()
        path.windingRule = .nonZero
        path.append(bar(left: near, right: far, top: markBounds.minY, bottom: markBounds.maxY))
        path.append(bar(left: markBounds.minX, right: markBounds.maxX, top: near, bottom: far))
        return path
    }
}
