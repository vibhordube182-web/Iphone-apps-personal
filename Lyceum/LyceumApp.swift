import SwiftUI

@main
struct LyceumApp: App {
    @StateObject private var store = NewsStore()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(store)
                .task { await store.refreshIfStale() }
        }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task {
                await store.refreshIfStale()
                await Notifications.reschedule()
            }
        }
    }
}
