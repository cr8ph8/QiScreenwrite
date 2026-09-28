import Foundation
import XCTest
@testable import ScreenwriteCore

final class PocketContinuationTests: XCTestCase {
    private let id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    private func continuation() -> PocketContinuation {
        .init(exchangeId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", projectId: "local-writer:fixture",
              draft: .init(id: "screenplay-draft:\(id)", version: 4, sha256: String(repeating: "a", count: 64)),
              development: .init(id: "story-development:\(id)", version: 6, sha256: String(repeating: "b", count: 64)))
    }
    func testLinkedPackageAndLocalHistoryKeepDistinctIdentities() throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: url) }
        let repo = try PocketRepository(directory: url)
        let snapshot = PocketSnapshot(id: id, body: "海 🎬\r\n", development: .init(world: .init(elements: [.init()])))
        let data = try PocketPackage.encodeContinuation(snapshot, continuation: continuation())
        var phone = try repo.importPackage(data, existing: [])
        XCTAssertNotEqual(phone.id, snapshot.id); XCTAssertEqual(phone.revisions.count, 1)
        phone.working.body += "Phone edit"; phone = try repo.saveRevision(phone)
        let reopened = try repo.load().documents[0]
        XCTAssertEqual(reopened, phone); XCTAssertEqual(reopened.revisions.count, 2)
        XCTAssertEqual(try repo.importPackage(data, existing: [reopened]), reopened)
        let returned = try PocketPackage.decodeTransfer(repo.exportContinuation(reopened))
        XCTAssertEqual(returned.snapshot.id, snapshot.id); XCTAssertEqual(returned.continuation, continuation())
        XCTAssertEqual(returned.snapshot.development.world, snapshot.development.world)
        XCTAssertEqual(returned.snapshot.body, phone.working.body)
        let copy = try PocketPackage.decodeTransfer(PocketPackage.encode(phone.working))
        XCTAssertNil(copy.continuation); XCTAssertEqual(copy.snapshot.id, phone.id)
    }
    func testV1HasNoContinuationAndCannotInventOneForReturn() throws {
        let data = try PocketPackage.encode(.init(id: id))
        XCTAssertNil(try PocketPackage.decodeTransfer(data).continuation)
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: url) }
        let repo = try PocketRepository(directory: url)
        let doc = try repo.importPackage(data, existing: [])
        XCTAssertThrowsError(try repo.exportContinuation(doc))
    }
    func testForeignIdentityAndInvalidBaseVersionsAreRejected() throws {
        let snapshot = PocketSnapshot(id: id)
        var invalid = continuation(); invalid.development.id = "story-development:\(UUID().uuidString)"
        XCTAssertThrowsError(try PocketPackage.encodeContinuation(snapshot, continuation: invalid))
        for value in [0, -1, 2147483647] {
            invalid = continuation(); invalid.draft.version = value
            XCTAssertThrowsError(try PocketPackage.encodeContinuation(snapshot, continuation: invalid))
        }
        invalid = continuation(); invalid.projectId = "a/b"
        XCTAssertThrowsError(try PocketPackage.encodeContinuation(snapshot, continuation: invalid))
    }
    func testStrictV2RejectsUnrecognizedContinuationFields() throws {
        let valid = try PocketPackage.encodeContinuation(.init(id: id), continuation: continuation())
        var envelope = try XCTUnwrap(JSONSerialization.jsonObject(with: valid) as? [String: Any])
        var payload = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(base64Encoded: envelope["payloadBase64"] as! String)!) as? [String: Any])
        var manifest = payload["continuation"] as! [String: Any]; manifest["approval"] = true; payload["continuation"] = manifest
        let bytes = try JSONSerialization.data(withJSONObject: payload)
        envelope["payloadBase64"] = bytes.base64EncodedString(); envelope["contentSha256"] = PocketPackage.sha256(bytes)
        XCTAssertThrowsError(try PocketPackage.decodeTransfer(JSONSerialization.data(withJSONObject: envelope)))
    }
}
