import XCTest

@testable import OcrCore

final class EnhanceScaleTests: XCTestCase {
  func testSmallPageIsUpscaledTo1600Wide() {
    XCTAssertEqual(enhanceScale(width: 800, height: 1000), 2, accuracy: 1e-9)
  }

  func testWidePageIsLeftAlone() {
    XCTAssertEqual(enhanceScale(width: 1632, height: 2000), 1)
  }

  func testLongReceiptIsCappedAt4000OnTheLongerSide() {
    // 400 x 6000: 4x would make it 24000 tall; the cap allows only 4000/6000.
    XCTAssertEqual(enhanceScale(width: 400, height: 6000), 1)
    XCTAssertEqual(enhanceScale(width: 400, height: 2000), 2, accuracy: 1e-9)
  }

  func testDegenerateSizesAreLeftAlone() {
    XCTAssertEqual(enhanceScale(width: 0, height: 100), 1)
  }
}
