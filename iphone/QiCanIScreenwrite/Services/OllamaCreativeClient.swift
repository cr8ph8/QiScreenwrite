import Foundation
import ScreenwriteCore

struct InstalledCreativeModel: Identifiable, Equatable, Sendable {
    let name: String
    let digest: String
    var id: String { name }
}

struct OllamaCreativeClient: Sendable {
    let endpoint: URL
    private let http = CreativeHTTP()

    init(endpoint: String) throws { self.endpoint = try CreativeAnalysis.localEndpoint(endpoint) }

    /// Only the Refresh models button calls this. No pulling or installation API exists in this client.
    func models() async throws -> (models: [InstalledCreativeModel], rejected: Int) {
        let data = try await http.request(endpoint.appendingPathComponent("api/tags"), maximumBytes: 512 * 1024)
        let root = try CreativeAnalysis.object(CreativeAnalysis.json(data))
        let rows = try CreativeAnalysis.array(root["models"], maximum: 512)
        var accepted: [InstalledCreativeModel] = [], rejected = 0
        for row in rows {
            do {
                let row = try CreativeAnalysis.object(row)
                try CreativeAnalysis.validateLocalMetadata(row)
                let name = try CreativeAnalysis.text(row["name"], limit: 200, nonblank: true)
                try CreativeAnalysis.validateLocalModelName(name)
                if let alias = row["model"] { try CreativeAnalysis.validateLocalModelName(CreativeAnalysis.text(alias, limit: 200, nonblank: true)) }
                let size = try CreativeAnalysis.number(row["size"], maximum: 9_007_199_254_740_991)
                let digest = try CreativeAnalysis.text(row["digest"], limit: 80, nonblank: true)
                guard size > 1_048_576, size.rounded(.towardZero) == size,
                      digest.range(of: "^[a-fA-F0-9]{64}$", options: .regularExpression) != nil,
                      !accepted.contains(where: { $0.name == name }) else { throw CreativeAnalysisError("Model has no verified local weights/digest or is duplicated.") }
                accepted.append(.init(name: name, digest: digest))
            } catch { rejected += 1 }
        }
        return (accepted.sorted { $0.name < $1.name }, rejected)
    }

    func analyze(input: AnalysisInput, model: InstalledCreativeModel) async throws -> AnalysisReport {
        try CreativeAnalysis.validate(input)
        try CreativeAnalysis.validateLocalModelName(model.name)
        // Probe immediately before sending any source text, even for innocently named remote aliases.
        let showBody = try JSONSerialization.data(withJSONObject: ["model": model.name])
        let showData = try await http.request(endpoint.appendingPathComponent("api/show"), body: showBody)
        let metadata = try CreativeAnalysis.object(CreativeAnalysis.json(showData))
        try CreativeAnalysis.validateLocalMetadata(metadata)
        let details = try CreativeAnalysis.object(metadata["details"])
        let format = try CreativeAnalysis.text(details["format"], limit: 60, nonblank: true)
        guard ["gguf", "safetensors"].contains(format.lowercased()) else { throw CreativeAnalysisError("The model does not declare a supported local weight format.") }
        let messages: [[String: String]] = [
            ["role": "system", "content": CreativeAnalysis.systemPrompt(kind: input.kind)],
            ["role": "user", "content": String(decoding: try CreativeAnalysis.encode(input), as: UTF8.self)]
        ]
        let messageBytes = try JSONSerialization.data(withJSONObject: messages, options: [.withoutEscapingSlashes]).count
        let context = try CreativeAnalysis.contextBudget(messageUTF8Bytes: messageBytes, metadata: metadata)
        let request: [String: Any] = ["model": model.name, "messages": messages, "stream": false, "think": false,
            "format": CreativeAnalysis.outputSchema(kind: input.kind),
            "options": ["num_ctx": context, "num_predict": 4096, "temperature": 0.2], "keep_alive": "0"]
        let data = try await http.request(endpoint.appendingPathComponent("api/chat"),
            body: JSONSerialization.data(withJSONObject: request), timeout: 180)
        return try CreativeAnalysis.decodeLocalResponse(data, input: input, model: model.name)
    }
}
