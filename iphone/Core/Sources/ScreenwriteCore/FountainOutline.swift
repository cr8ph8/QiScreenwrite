import Foundation

public struct FountainScene: Identifiable, Equatable, Sendable {
    public var id: String
    public var heading: String
    public var text: String
    public var line: Int
    public var number: String?
    public var worldReference: String?
}

/// A bounded outline for navigation, never a source of persistent scene IDs.
/// Repeated unnumbered headings have no linkable reference.
public enum FountainOutline {
    public static func scenes(in body: String) -> [FountainScene] {
        guard body.utf16.count <= 200_000 else { return [] }
        let lines = body.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n").components(separatedBy: "\n")
        var starts: [(index: Int, heading: String, number: String?)] = []
        var inComment = false
        for (index, original) in lines.enumerated() {
            var line = original.trimmingCharacters(in: .whitespaces)
            // Comments can contain apparent screenplay headings; omit those from navigation.
            if inComment {
                if let end = line.range(of: "*/") { line = String(line[end.upperBound...]); inComment = false }
                else { continue }
            }
            while let start = line.range(of: "/*") {
                if let end = line.range(of: "*/", range: start.upperBound..<line.endIndex) { line.removeSubrange(start.lowerBound..<end.upperBound) }
                else { line = String(line[..<start.lowerBound]); inComment = true; break }
            }
            line = line.trimmingCharacters(in: .whitespaces)
            let forced = line.hasPrefix(".") && !line.hasPrefix("..")
            let regular = line.range(of: "^(INT\\.?/EXT\\.?|EXT\\.?/INT\\.?|INT|EXT|EST|I/E)(\\.|\\s)", options: [.regularExpression, .caseInsensitive]) != nil
            guard forced || regular else { continue }
            // Require a paragraph start, as the shared desktop parser does.
            guard index == 0 || lines[index - 1].trimmingCharacters(in: .whitespaces).isEmpty else { continue }
            if forced { line.removeFirst() }
            var number: String?
            if let range = line.range(of: "\\s+#[\\p{L}\\p{N}][\\p{L}\\p{N}._-]*#$", options: .regularExpression) {
                number = String(line[range]).trimmingCharacters(in: .whitespaces).trimmingCharacters(in: CharacterSet(charactersIn: "#"))
                line = String(line[..<range.lowerBound])
            }
            starts.append((index, line.trimmingCharacters(in: .whitespaces), number))
        }
        let headings = Dictionary(grouping: starts, by: \.heading).mapValues(\.count)
        let numbers = Dictionary(grouping: starts.compactMap(\.number), by: { $0 }).mapValues(\.count)
        return starts.enumerated().map { offset, scene in
            let end = offset + 1 < starts.count ? starts[offset + 1].index : lines.count
            var reference: String?
            if let number = scene.number, numbers[number] == 1 { reference = "number:\(number)" }
            else if headings[scene.heading] == 1 { reference = "heading:\(scene.heading)" }
            if scene.heading.utf16.count > 500 || (reference?.utf16.count ?? 0) > 500 { reference = nil }
            return .init(id: "outline-\(scene.index)", heading: scene.heading, text: lines[scene.index..<end].joined(separator: "\n"), line: scene.index + 1, number: scene.number, worldReference: reference)
        }
    }
}
