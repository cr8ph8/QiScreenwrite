import XCTest
@testable import ScreenwriteCore

final class PocketRepositoryTests: XCTestCase {
    private func repository() throws -> PocketRepository {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return try PocketRepository(directory: url)
    }
    func testRecoverySurvivesReopenWithoutInventingRevision() throws {
        let repo = try repository(); var doc = try repo.newDocument()
        doc.working.body = "INT. HARBOR - DAY\r\n\r\n海 🎬"; try repo.persist(doc)
        let loaded = try PocketRepository(directory: repo.directory).load()
        XCTAssertEqual(loaded.documents.first?.working.body, doc.working.body)
        XCTAssertEqual(loaded.documents.first?.revisions.count, 0)
        XCTAssertTrue(loaded.issues.isEmpty)
    }
    func testExplicitHistoryAndRestoreDoNotErasePriorWriting() throws {
        let repo = try repository(); var doc = try repo.newDocument(body: "First")
        doc = try repo.saveRevision(doc)
        doc.working.body = "Second"; doc = try repo.saveRevision(doc)
        doc.working = doc.revisions[0].snapshot; try repo.persist(doc)
        let loaded = try repo.load().documents[0]
        XCTAssertEqual(loaded.revisions.map(\.snapshot.body), ["First", "Second"])
        XCTAssertEqual(loaded.working.body, "First")
        XCTAssertTrue(loaded.hasUnsavedRevision)
    }
    func testExactImportRetryReturnsExistingEditedCopy() throws {
        let repo = try repository(); let source = PocketSnapshot(title: "Source", body: "Original")
        let bytes = try PocketPackage.encode(source)
        var imported = try repo.importPackage(bytes, existing: [])
        XCTAssertNotEqual(imported.id, source.id)
        imported.working.body = "Local edits"; imported = try repo.saveRevision(imported)
        let replay = try repo.importPackage(bytes, existing: [imported])
        XCTAssertEqual(replay, imported)
        XCTAssertEqual(try repo.load().documents.count, 1)
    }
    func testInvalidEditsCannotReplaceRecovery() throws {
        let repo = try repository(); var doc = try repo.newDocument(body: "Safe")
        doc.working.body = String(repeating: "x", count: 200_001)
        XCTAssertThrowsError(try repo.persist(doc))
        XCTAssertEqual(try repo.load().documents[0].working.body, "Safe")
    }
    func testCorruptFileIsReportedAndNeverReplaced() throws {
        let repo = try repository(); let doc = try repo.newDocument(body: "Original")
        let file = repo.directory.appendingPathComponent(doc.id).appendingPathExtension("qilocal")
        let bytes = Data("damaged data".utf8); try bytes.write(to: file)
        let loaded = try repo.load()
        XCTAssertEqual(loaded.documents.count, 0); XCTAssertEqual(loaded.issues.count, 1)
        XCTAssertEqual(try Data(contentsOf: file), bytes)
    }
    func testOutlineNeverLinksRepeatedUnnumberedHeadingsOrBoneyard() {
        let body = "/*\nINT. OMITTED - DAY\n*/\n\nINT. ROOM - DAY\n\nA.\n\nINT. ROOM - DAY\n\nB.\n\nEXT. BOAT - NIGHT #2#\n\nSea."
        let scenes = FountainOutline.scenes(in: body)
        XCTAssertEqual(scenes.count, 3)
        XCTAssertNil(scenes[0].worldReference); XCTAssertNil(scenes[1].worldReference)
        XCTAssertEqual(scenes[2].worldReference, "number:2")
        XCTAssertEqual(scenes[2].heading, "EXT. BOAT - NIGHT")
    }
}
