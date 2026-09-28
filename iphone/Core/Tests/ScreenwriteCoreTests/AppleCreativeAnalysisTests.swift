import Foundation
import XCTest
@testable import ScreenwriteCore

final class AppleCreativeAnalysisTests: XCTestCase {
    func testOpeningPassageKeepsFullSourceHashAndUnicodeBoundaries() throws {
        let body = String(repeating: "a", count: 1599) + "🎬 e\u{301}\r\n"
        let input = try CreativeAnalysis.freezeOnDevice(draftId: "draft", title: "Film", body: body, kind: .screenplayProfile)
        XCTAssertEqual(input.source.excerpt, String(repeating: "a", count: 1599))
        XCTAssertEqual(input.source.scope, .excerpt)
        XCTAssertEqual(input.source.bodySha256, PocketPackage.sha256(Data(body.utf8)))
        XCTAssertEqual(try CreativeAnalysis.decodeInput(CreativeAnalysis.encode(input)), input)
    }
    func testUnsupportedScopeScoringAndOversizeAreRejected() throws {
        XCTAssertThrowsError(try CreativeAnalysis.freezeOnDevice(draftId: "d", title: "F", body: "A scene", kind: .coverage))
        XCTAssertThrowsError(try CreativeAnalysis.freezeOnDevice(draftId: "d", title: "F", body: " ", kind: .screenplayProfile))
        let full = try CreativeAnalysis.freeze(draftId: "d", title: "F", body: "Scene", kind: .screenplayProfile, scope: .full)
        XCTAssertThrowsError(try CreativeAnalysis.validateOnDevice(full))
        let long = try CreativeAnalysis.freeze(draftId: "d", title: "F", body: String(repeating: "z", count: 1601), kind: .screenplayProfile, scope: .excerpt)
        XCTAssertThrowsError(try CreativeAnalysis.validateOnDevice(long))
    }
    func testReportKeepsUnknownUsageAndRefusesProviderCostForgery() throws {
        let input = try CreativeAnalysis.freezeOnDevice(draftId: "d", title: "F", body: "A door opens.", kind: .screenplayProfile)
        let output = try CreativeAnalysis.decodeOutput(Data(#"{"summary":"An opening.","strengths":[],"concerns":[],"nextSteps":[],"sections":[],"scores":[]}"#.utf8), input: input)
        let report = try CreativeAnalysis.onDeviceReport(input: input, output: output)
        XCTAssertEqual(report.provider, .apple)
        XCTAssertEqual(report.platformCredits, 0)
        XCTAssertNil(report.usage.inputTokens)
        XCTAssertNil(report.usage.outputTokens)
        XCTAssertEqual(try CreativeAnalysis.decodeReport(CreativeAnalysis.encode(report)), report)
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: CreativeAnalysis.encode(report)) as? [String: Any])
        json["platformCredits"] = 1
        XCTAssertThrowsError(try CreativeAnalysis.decodeReport(JSONSerialization.data(withJSONObject: json)))
        json["platformCredits"] = 0; json["model"] = "cloud-model"
        XCTAssertThrowsError(try CreativeAnalysis.decodeReport(JSONSerialization.data(withJSONObject: json)))
    }
}
