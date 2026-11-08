import AppKit
import XCTest

final class StatusItemIconTests: XCTestCase {
    /// The rule the first version broke. A non-template status image is drawn in
    /// whatever colour the symbol carries, which on a dark or tinted menu bar is
    /// a mark a person cannot see — and `contentTintColor` does not apply to a
    /// non-template image, so the tint that was supposed to save it did nothing.
    func testEveryStateIsATemplateImage() {
        for icon in [MenuIcon.idle, .working, .needsYou] {
            XCTAssertTrue(
                StatusItemIcon.image(for: icon).isTemplate,
                "\(icon) must be a template image so the system tints it for this menu bar"
            )
        }
    }

    /// One letter, always the same box, so a person learns where it is once and
    /// does not have to hunt for a different picture each time the state changes.
    func testEveryStateOccupiesTheSameFootprint() {
        for icon in [MenuIcon.idle, .working, .needsYou] {
            XCTAssertEqual(StatusItemIcon.image(for: icon).size, StatusItemIcon.size)
        }
        XCTAssertEqual(StatusItemIcon.size, NSSize(width: 18, height: 18))
    }

    /// The defect this replaces: the quiet state stroked `markPath`, a composite of
    /// two stems plus the diagonal. Stroking outlines every subpath, interior
    /// edges included, so at 18pt the letter became hairline loops. A stroked
    /// state is detectable from the drawing alone — an outline leaves the
    /// letter's inside transparent, while a fill does not — so this asserts on
    /// the pixels rather than trusting the source to stay a fill.
    func testNoStateIsDrawnAsAnOutline() throws {
        for icon in [MenuIcon.idle, .working, .needsYou] {
            let opaque = try coverage(of: icon)
            XCTAssertGreaterThan(
                opaque.interiorFilled, 0.6,
                "\(icon) leaves the inside of the letter hollow, which is a stroked path"
            )
        }
    }

    /// Idle and working are the same mark at different tints, so they must
    /// cover the same pixels and differ in what those pixels contain.
    func testStoppedAndRunningAreTheSameLetterAtDifferentTints() throws {
        let stopped = try XCTUnwrap(StatusItemIcon.image(for: .idle).tiffRepresentation)
        let running = try XCTUnwrap(StatusItemIcon.image(for: .working).tiffRepresentation)
        XCTAssertNotEqual(stopped, running, "idle and working must be distinguishable")
        let stoppedCoverage = try coverage(of: .idle)
        let runningCoverage = try coverage(of: .working)
        XCTAssertEqual(
            stoppedCoverage.anyInk, runningCoverage.anyInk, accuracy: 0.02,
            "the same letter must cover the same area whatever the tint"
        )
        XCTAssertLessThan(
            stoppedCoverage.meanAlpha, runningCoverage.meanAlpha * 0.7,
            "idle must read as the quieter of the two"
        )
    }

    /// What a template image must never be: empty. An all-transparent status
    /// item looks exactly like an app that failed to launch.
    func testTheMarkActuallyCoversPartOfItsBox() throws {
        for icon in [MenuIcon.idle, .working, .needsYou] {
            let measured = try coverage(of: icon)
            XCTAssertGreaterThan(measured.anyInk, 0.15, "\(icon) draws almost nothing")
            XCTAssertLessThan(measured.anyInk, 0.95, "\(icon) fills its whole box")
        }
    }

    /// `anyInk` is the share of the box carrying any ink; `meanAlpha` is the
    /// average alpha over that ink, which is what a tint changes; `interiorFilled`
    /// is the share of the mark's own bounding box rows that are solid between
    /// their first and last inked pixel — the measurement an outline fails.
    private struct Coverage {
        var anyInk: Double
        var meanAlpha: Double
        var interiorFilled: Double
    }

    /// Rasterised at a fixed scale rather than through
    /// `cgImage(forProposedRect:nil, …)`, which renders at the MAIN SCREEN's
    /// backing scale — that made every measurement below depend on which
    /// display the suite happened to run on, and it failed deterministically on
    /// a Mac whose scale differed from the one it was written on.
    private func rasterise(
        _ icon: MenuIcon, file: StaticString = #filePath, line: UInt = #line
    ) throws -> NSBitmapImageRep {
        let side = Int(StatusItemIcon.size.width) * 4
        let bitmap = try XCTUnwrap(NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: side, pixelsHigh: side,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
        ), file: file, line: line)
        let context = try XCTUnwrap(NSGraphicsContext(bitmapImageRep: bitmap), file: file, line: line)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        StatusItemIcon.image(for: icon)
            .draw(in: NSRect(x: 0, y: 0, width: CGFloat(side), height: CGFloat(side)))
        NSGraphicsContext.restoreGraphicsState()
        return bitmap
    }

    private func coverage(
        of icon: MenuIcon, file: StaticString = #filePath, line: UInt = #line
    ) throws -> Coverage {
        let bitmap = try rasterise(icon, file: file, line: line)
        var strongest = 0.0
        for row in 0..<bitmap.pixelsHigh {
            for column in 0..<bitmap.pixelsWide {
                strongest = max(strongest, Double(bitmap.colorAt(x: column, y: row)?.alphaComponent ?? 0))
            }
        }
        // The ink threshold is a share of this icon's OWN strongest ink, not a
        // fixed alpha. A tinted copy of the same letter has every pixel scaled
        // by the same factor, so a fixed threshold silently drops its faintest
        // antialiased edges and reports the quieter icon as a smaller letter —
        // which is exactly the shape difference these assertions exist to catch.
        let inkThreshold = strongest * 0.05
        var inked = 0
        var alphaTotal = 0.0
        var spanPixels = 0
        var filledPixels = 0
        for row in 0..<bitmap.pixelsHigh {
            var first: Int?
            var last: Int?
            for column in 0..<bitmap.pixelsWide {
                let alpha = Double(bitmap.colorAt(x: column, y: row)?.alphaComponent ?? 0)
                if alpha > inkThreshold {
                    inked += 1
                    alphaTotal += alpha
                    if first == nil { first = column }
                    last = column
                }
            }
            guard let first, let last, last > first else { continue }
            for column in first...last {
                spanPixels += 1
                if Double(bitmap.colorAt(x: column, y: row)?.alphaComponent ?? 0) > inkThreshold {
                    filledPixels += 1
                }
            }
        }
        let area = Double(bitmap.pixelsWide * bitmap.pixelsHigh)
        return Coverage(
            anyInk: Double(inked) / area,
            meanAlpha: inked == 0 ? 0 : alphaTotal / Double(inked),
            interiorFilled: spanPixels == 0 ? 0 : Double(filledPixels) / Double(spanPixels)
        )
    }

    /// VoiceOver hears the sentence the menu chose, in the person's language.
    func testTheImageCarriesTheDescriptionItIsGiven() {
        let menu = ComputerMenuModel(teams: [], language: .czech)
        let image = StatusItemIcon.image(for: menu.icon, description: menu.iconDescription)
        XCTAssertEqual(image.accessibilityDescription, "Nessie Computer: nepracuje")
    }
}
