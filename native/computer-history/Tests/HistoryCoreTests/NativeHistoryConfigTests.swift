import XCTest
@testable import HistoryCore
final class NativeHistoryConfigTests: XCTestCase {
  func testRecordingRequiresOptIn() { XCTAssertFalse(NativeHistoryConfig().enabled) }
  func testSiteRuleDoesNotMatchLookalikeDomain() {
    var config = NativeHistoryConfig(); config.sites = ["example.com"]
    XCTAssertFalse(config.allowsSite("sub.example.com")); XCTAssertTrue(config.allowsSite("notexample.com"))
    config.siteMode = "include"; XCTAssertTrue(config.allowsSite("EXAMPLE.COM")); XCTAssertFalse(config.allowsSite("example.com.evil.test"))
  }
  func testApplicationRulesAndSecureRoles() {
    var config = NativeHistoryConfig(); config.appMode = "include"; config.apps = ["Preview"]
    XCTAssertTrue(config.allowsApplication("Preview", "com.apple.Preview")); XCTAssertFalse(config.allowsApplication("Mail", "com.apple.mail"))
    XCTAssertTrue(NativeHistoryConfig.isSensitive("AXSecureTextField"))
    XCTAssertTrue(NativeHistoryConfig.isBrowser("com.apple.Safari"))
  }
}
