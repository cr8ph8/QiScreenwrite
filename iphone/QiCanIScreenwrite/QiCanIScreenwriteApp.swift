import SwiftUI
import ScreenwriteCore

/// One native engine, two installed identities. Alpha storage never aliases the writer.
enum AppIdentity {
    static var isQiMoviAlpha: Bool { Bundle.main.object(forInfoDictionaryKey: "QiMoviAlpha") as? Bool == true }
    static var name: String { isQiMoviAlpha ? "QiMovi Alpha" : "QiCanIScreenwrite" }
    static var mark: String { isQiMoviAlpha ? "QiMoviBrandMark" : "BrandMark" }
    static var libraryFolder: String { isQiMoviAlpha ? "QiMoviAlpha" : "QiCanIScreenwrite" }
    static var version: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "preview" }
}

@main struct QiCanIScreenwriteApp: App {
    @State private var store = PocketStore()
    @Environment(\.scenePhase) private var phase
    var body: some Scene {
        WindowGroup {
            StudioView(store: store)
                .tint(Color(red: 0.87, green: 0.70, blue: 0.32))
                .preferredColorScheme(.dark)
                .onChange(of: phase) { _, value in if value != .active { store.flushAll() } }
        }
    }
}
