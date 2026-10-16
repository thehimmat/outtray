import XCTest

@testable import OcrCore

final class ReadingOrderTests: XCTestCase {
  func line(_ text: String, x: Double, y: Double, h: Double = 0.015) -> Line {
    Line(text: text, confidence: 1, box: Box(x: x, y: y, width: 0.1, height: h))
  }

  func texts(_ lines: [Line]) -> [String] { readingOrder(lines).map(\.text) }

  func testLabelAndTallerValueOnOneBaselinePairUp() {
    // From bill-001: the amount is set larger and starts a little higher.
    let order = texts([
      line("$91.00", x: 0.80, y: 0.3632, h: 0.028),
      line("Total amount due", x: 0.10, y: 0.3675, h: 0.015),
      line("Late fee", x: 0.10, y: 0.4273),
    ])
    XCTAssertEqual(order, ["Total amount due", "$91.00", "Late fee"])
  }

  func testTallHeadingDoesNotSwallowTheLinesBesideIt() {
    let order = texts([
      line("HEADING", x: 0.05, y: 0.10, h: 0.06),
      line("side one", x: 0.70, y: 0.10, h: 0.015),
      line("side two", x: 0.70, y: 0.12, h: 0.015),
    ])
    XCTAssertEqual(order, ["HEADING", "side one", "side two"])
  }

  func testRowsComeTopToBottomWhateverTheInputOrder() {
    let order = texts([
      line("third", x: 0.1, y: 0.5),
      line("first", x: 0.1, y: 0.1),
      line("second", x: 0.1, y: 0.3),
    ])
    XCTAssertEqual(order, ["first", "second", "third"])
  }

  func testBoxesAreClampedAndRounded() {
    let box = Box(x: -0.2, y: 0.123456, width: 1.7, height: 0.00004)
    XCTAssertEqual(box, Box(x: 0, y: 0.1235, width: 1, height: 0))
  }
}
