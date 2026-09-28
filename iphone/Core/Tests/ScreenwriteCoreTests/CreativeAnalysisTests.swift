import Foundation
import XCTest
@testable import ScreenwriteCore

final class CreativeAnalysisTests: XCTestCase {
    private func input(_ kind: AnalysisKind = .coverage, body: String = "INT. ROOM - NIGHT\r\nÉVA waits. A clock stops.\n") throws -> AnalysisInput {
        try CreativeAnalysis.freeze(draftId: "test-draft", title: "Synthetic test", body: body, kind: kind,
            scope: .full, characterName: kind == .characterProfile ? "ÉVA" : "")
    }
    private func output(_ kind: AnalysisKind = .coverage) -> [String: Any] {
        ["summary": "A waiting scene; whole-arc evidence is unknown.", "strengths": ["A clear image."],
         "concerns": [], "nextSteps": ["Consider the next action."],
         "sections": [["heading": "Observation", "body": "A stopped clock suggests tension.", "evidence": "A clock stops."]],
         "scores": kind == .coverage ? CreativeAnalysis.rubric.map { ["key": $0.key, "score": $0.maximum, "evidence": ""] as [String: Any] } : []]
    }
    private func json(_ object: Any) throws -> Data { try JSONSerialization.data(withJSONObject: object, options: .sortedKeys) }
    private func reject(_ object: Any, kind: AnalysisKind = .coverage, file: StaticString = #filePath, line: UInt = #line) throws {
        XCTAssertThrowsError(try CreativeAnalysis.decodeOutput(json(object), input: input(kind)), file: file, line: line)
    }

    func testFrozenRequestHashesFullBodyAndPreservesExactText() throws {
        let text = "  e\u{301} 🎬\r\nINT. ROOM - NIGHT\n  "
        let request = try input(.screenplayProfile, body: text)
        XCTAssertEqual(Data(request.source.excerpt.utf8), Data(text.utf8))
        XCTAssertEqual(request.source.bodySha256, PocketPackage.sha256(Data(text.utf8)))
        XCTAssertEqual(request.schemaVersion, 1)
        XCTAssertEqual(request.characterName, "")
        XCTAssertTrue(try CreativeAnalysis.sameInput(request, CreativeAnalysis.decodeInput(CreativeAnalysis.encode(request))))
    }

    func testOpeningExcerptRequiresExplicitChoiceAndNeverSplitsUnicode() throws {
        let body = String(repeating: "x", count: 11_999) + "🎬remainder"
        XCTAssertThrowsError(try input(body: body))
        let request = try CreativeAnalysis.freeze(draftId: "a", title: "T", body: body, kind: .coverage, scope: .excerpt)
        XCTAssertEqual(request.source.scope, .excerpt)
        XCTAssertEqual(request.source.excerpt.utf16.count, 11_999)
        XCTAssertEqual(request.source.bodySha256, PocketPackage.sha256(Data(body.utf8)))
        XCTAssertNotEqual(request.source.bodySha256, PocketPackage.sha256(Data(request.source.excerpt.utf8)))
        XCTAssertTrue(body.hasPrefix(request.source.excerpt))
        XCTAssertEqual(try input(body: String(repeating: "🎬", count: 6000)).source.excerpt.utf16.count, 12_000)
    }

    func testInputRejectsBlankWrongHashUnknownFieldsAndOversizeUTF16() throws {
        XCTAssertThrowsError(try input(body: " \n\t"))
        XCTAssertThrowsError(try CreativeAnalysis.freeze(draftId: "x", title: "", body: "x", kind: .characterProfile, scope: .full))
        XCTAssertThrowsError(try CreativeAnalysis.freeze(draftId: "x", title: String(repeating: "🎬", count: 101), body: "x", kind: .coverage, scope: .full))
        var raw = try XCTUnwrap(JSONSerialization.jsonObject(with: CreativeAnalysis.encode(input())) as? [String: Any])
        var source = try XCTUnwrap(raw["source"] as? [String: Any])
        source["bodySha256"] = String(repeating: "a", count: 64); raw["source"] = source
        XCTAssertThrowsError(try CreativeAnalysis.decodeInput(json(raw)))
        raw = try XCTUnwrap(JSONSerialization.jsonObject(with: CreativeAnalysis.encode(input())) as? [String: Any])
        raw["price"] = 1
        XCTAssertThrowsError(try CreativeAnalysis.decodeInput(json(raw)))
    }

    func testCanonicalComparisonAcceptsJSONBKeyOrderButRejectsTextDrift() throws {
        let request = try input(.screenplayProfile, body: "é")
        let serialized = try CreativeAnalysis.encode(request)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: serialized) as? [String: Any])
        let reordered = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted])
        XCTAssertTrue(try CreativeAnalysis.sameInput(request, CreativeAnalysis.decodeInput(reordered)))
        let other = try input(.screenplayProfile, body: "e\u{301}")
        XCTAssertEqual(request.source.excerpt, other.source.excerpt) // Swift normalizes equality.
        XCTAssertFalse(try CreativeAnalysis.sameInput(request, other)) // Contract bytes differ.
    }

    func testNineCategory120PointTotalAndProfiles() throws {
        XCTAssertEqual(CreativeAnalysis.rubric.count, 9)
        XCTAssertEqual(CreativeAnalysis.rubric.reduce(0) { $0 + $1.maximum }, 120)
        let parsed = try CreativeAnalysis.decodeOutput(json(output()), input: input())
        XCTAssertEqual(parsed.coverageTotal, 120)
        for kind in [AnalysisKind.screenplayProfile, .characterProfile] {
            XCTAssertNil(try CreativeAnalysis.decodeOutput(json(output(kind)), input: input(kind)).coverageTotal)
            try reject(output(), kind: kind)
        }
        XCTAssertEqual(CreativeAnalysis.diamondTerms, ["North Star", "Counter-Star", "Flaw / Mask", "Non-Negotiable"])
    }

    func testUnknownDuplicateMissingOutOfRangeAndBooleanScoresFail() throws {
        for bad: Any in ["unknown", "story"] {
            var out = output(); var scores = try XCTUnwrap(out["scores"] as? [[String: Any]])
            scores[0]["key"] = bad; out["scores"] = scores; try reject(out)
        }
        for bad: Any in [-1, 15.1, true, "12", NSNull()] {
            var out = output(); var scores = try XCTUnwrap(out["scores"] as? [[String: Any]])
            scores[0]["score"] = bad; out["scores"] = scores; try reject(out)
        }
        var out = output(); out["scores"] = []; try reject(out)
        out = output(); out["total"] = 120; try reject(out)
        out = output(); out["summary"] = " \n"; try reject(out)
    }

    func testEvidenceMustBeExactSubstringOrEmptyWithoutNormalization() throws {
        for evidence in ["A clock stopped.", "a clock stops.", "invented quote", "E\u{301}VA"] {
            var out = output()
            out["sections"] = [["heading": "H", "body": "B", "evidence": evidence]]
            try reject(out)
        }
        var out = output(); var scores = try XCTUnwrap(out["scores"] as? [[String: Any]])
        scores[0]["evidence"] = "Not in the screenplay"; out["scores"] = scores; try reject(out)
        for evidence in ["", "ÉVA waits.", "ROOM - NIGHT\r\nÉVA"] {
            var out = output(); out["sections"] = [["heading": "H", "body": "B", "evidence": evidence]]
            XCTAssertNoThrow(try CreativeAnalysis.decodeOutput(json(out), input: input()))
        }
    }

    func testBrokenOversizedTruncatedAndDuplicateKeyOutputFailsVisibly() throws {
        for broken in ["{}", "[]", "{", "null", "```json\n{}\n```", "{} trailing", "{\"summary\":\"a\",\"summ\\u0061ry\":\"b\"}", "{\"x\":NaN}"] {
            XCTAssertThrowsError(try CreativeAnalysis.decodeOutput(Data(broken.utf8), input: input()))
        }
        let valid = try json(output())
        XCTAssertThrowsError(try CreativeAnalysis.decodeOutput(valid.dropLast(), input: input()))
        var out = output(); out["summary"] = String(repeating: "🎬", count: 2001); try reject(out)
        out = output(); out["strengths"] = Array(repeating: "x", count: 9); try reject(out)
        out = output(); out["strengths"] = [""]; try reject(out)
        XCTAssertThrowsError(try CreativeAnalysis.json(Data(repeating: 32, count: CreativeAnalysis.maximumJSONBytes + 1)))
        XCTAssertThrowsError(try CreativeAnalysis.json(Data((String(repeating: "[", count: 26) + "0" + String(repeating: "]", count: 26)).utf8)))
    }

    func testLocalEndpointAllowsOnlyCanonicalPrivateIPv4AndLoopback() throws {
        for url in ["http://10.0.0.1:11434", "https://172.16.0.1", "http://172.31.255.254:1/", "http://192.168.0.20:65535", "http://127.0.0.1:11434", "http://[::1]:11434"] {
            XCTAssertNoThrow(try CreativeAnalysis.localEndpoint(url), url)
        }
        for url in ["http://8.8.8.8", "http://169.254.169.254", "http://172.15.0.1", "http://172.32.0.1", "http://192.169.0.1",
                    "http://0.0.0.0", "http://100.64.0.1", "http://224.0.0.1", "http://localhost", "http://my-mac.local", "https://ollama.com",
                    "http://127.1", "http://2130706433", "http://0x7f000001", "http://010.0.0.1", "http://192.168.001.1",
                    "http://[::ffff:127.0.0.1]", "http://user:pass@192.168.1.2", "http://192.168.1.2/api", "http://192.168.1.2?x=1",
                    "http://192.168.1.2#x", "http://192.168.1.2:0", "http://192.168.1.2:65536", "ftp://192.168.1.2", " http://192.168.1.2",
                    "http://192.168.1.2%2f.evil.com", "http://192.168.1.2\\@evil.com"] {
            XCTAssertThrowsError(try CreativeAnalysis.localEndpoint(url), url)
        }
    }

    func testCloudNamesAndRemoteMetadataRejectAliases() throws {
        XCTAssertNoThrow(try CreativeAnalysis.validateLocalModelName("qwen3:1.7b"))
        for name in ["qwen:cloud", "CLOUD-model", "https://ollama.com/model", "../model", "", "name with space"] {
            XCTAssertThrowsError(try CreativeAnalysis.validateLocalModelName(name))
        }
        for metadata: [String: Any] in [["remote_host": "https://example.com"], ["details": ["remote_model": "model"]], ["cloud": true], ["nested": [["remote": ["host": "x"]]]], ["modelfile": "FROM model:cloud"]] {
            XCTAssertThrowsError(try CreativeAnalysis.validateLocalMetadata(metadata))
        }
        XCTAssertNoThrow(try CreativeAnalysis.validateLocalMetadata(["remote_host": "", "remote_model": NSNull(), "cloud": false, "details": ["format": "gguf"]]))
    }

    func testConservativeContextBudgetUsesUTF8BytesOutputAllowanceAndCeilings() throws {
        let metadata: [String: Any] = ["model_info": ["general.architecture": "qwen3", "qwen3.context_length": 32_768]]
        XCTAssertEqual(try CreativeAnalysis.contextBudget(messageUTF8Bytes: 1024, metadata: metadata), 5120)
        XCTAssertEqual(try CreativeAnalysis.contextBudget(messageUTF8Bytes: 1025, metadata: metadata), 6144)
        let message = String(repeating: "🎬", count: 1000)
        XCTAssertEqual(try CreativeAnalysis.contextBudget(messageUTF8Bytes: message.utf8.count, metadata: metadata), 8192)
        XCTAssertThrowsError(try CreativeAnalysis.contextBudget(messageUTF8Bytes: 30_000, metadata: metadata))
        XCTAssertThrowsError(try CreativeAnalysis.contextBudget(messageUTF8Bytes: 64_000, metadata: ["model_info": ["general.architecture": "a", "a.context_length": 1_000_000]]))
        XCTAssertThrowsError(try CreativeAnalysis.contextBudget(messageUTF8Bytes: 100, metadata: [:]))
        XCTAssertThrowsError(try CreativeAnalysis.contextBudget(messageUTF8Bytes: 100, metadata: ["model_info": ["general.architecture": "qwen3", "qwen3.context_length": true]]))
    }

    func testResponseRejectsWrongModelRoleToolsImagesAndIncompleteOutput() throws {
        let request = try input()
        let content = String(decoding: try json(output()), as: UTF8.self)
        let good: [String: Any] = ["model": "qwen3:1.7b", "done": true, "done_reason": "stop", "message": ["role": "assistant", "content": content]]
        let report = try CreativeAnalysis.decodeLocalResponse(json(good), input: request, model: "qwen3:1.7b")
        XCTAssertEqual(report.platformCredits, 0)
        XCTAssertNil(report.usage.inputTokens)
        for (key, bad): (String, Any) in [("model", "qwen3:8b"), ("done", false), ("done", 1), ("done_reason", "length"), ("remote_model", "model"), ("images", ["data"]), ("error", "failed")] {
            var mutated = good; mutated[key] = bad
            XCTAssertThrowsError(try CreativeAnalysis.decodeLocalResponse(json(mutated), input: request, model: "qwen3:1.7b"))
        }
        for message: [String: Any] in [["role": "user", "content": content], ["role": "assistant", "content": content, "tool_calls": [["name": "exec"]]], ["role": "assistant", "content": content, "images": ["x"]]] {
            var mutated = good; mutated["message"] = message
            XCTAssertThrowsError(try CreativeAnalysis.decodeLocalResponse(json(mutated), input: request, model: "qwen3:1.7b"))
        }
    }

    func testReportContractNullUsageRoundTripAndNoLocalCharges() throws {
        let request = try input()
        let report = try CreativeAnalysis.localReport(input: request, model: "qwen3:1.7b",
            output: CreativeAnalysis.decodeOutput(json(output()), input: request), usage: .init(inputTokens: nil, outputTokens: 120))
        let data = try CreativeAnalysis.encode(report)
        XCTAssertEqual(try CreativeAnalysis.decodeReport(data), report)
        var raw = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(Set(raw.keys), ["schemaVersion", "id", "createdAt", "input", "provider", "model", "platformCredits", "output", "usage"])
        let usage = try XCTUnwrap(raw["usage"] as? [String: Any]); XCTAssertTrue(usage["inputTokens"] is NSNull)
        raw["platformCredits"] = 1; XCTAssertThrowsError(try CreativeAnalysis.decodeReport(json(raw)))
        raw["provider"] = "hosted"; raw["platformCredits"] = 1.5; XCTAssertThrowsError(try CreativeAnalysis.decodeReport(json(raw)))
    }

    func testStructuredSchemaAndPromptRetainRequiredFieldsAndDiamondTerms() throws {
        let schema = CreativeAnalysis.outputSchema(kind: .characterProfile)
        XCTAssertEqual(schema["additionalProperties"] as? Bool, false)
        let properties = try XCTUnwrap(schema["properties"] as? [String: Any])
        XCTAssertEqual(Set(properties.keys), ["summary", "strengths", "concerns", "nextSteps", "sections", "scores"])
        let scores = try XCTUnwrap(properties["scores"] as? [String: Any])
        XCTAssertEqual(scores["maxItems"] as? Int, 0)
        let prompt = CreativeAnalysis.systemPrompt(kind: .characterProfile)
        for term in CreativeAnalysis.diamondTerms { XCTAssertTrue(prompt.contains(term)) }
        XCTAssertTrue(prompt.contains("exact substring"))
    }
}
