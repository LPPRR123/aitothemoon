import SwiftUI
import AVFoundation

@main
struct MemoryAlbumARApp: App {
    @StateObject private var store = MemoryStore()

    init() {
        // 即使手机拨到静音，视频也有声音
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
    }

    var body: some Scene {
        WindowGroup {
            LibraryView()
                .environmentObject(store)
        }
    }
}
