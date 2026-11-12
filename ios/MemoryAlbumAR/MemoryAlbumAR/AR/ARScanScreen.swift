import SwiftUI
import ARKit

/// 扫描界面：全屏相机画面 + 上面一层提示和按钮。
struct ARScanScreen: View {
    @EnvironmentObject private var store: MemoryStore
    @Environment(\.dismiss) private var dismiss

    @State private var muted = false
    @State private var nowPlaying: String?
    @State private var problem: String?

    var body: some View {
        ZStack {
            if ARImageTrackingConfiguration.isSupported {
                ARAlbumView(targets: targets, muted: muted, nowPlaying: $nowPlaying, problem: $problem)
                    .ignoresSafeArea()
            } else {
                Color.black.ignoresSafeArea()
            }

            VStack {
                HStack {
                    circleButton("xmark") { dismiss() }
                        .accessibilityLabel("关闭")
                    Spacer()
                    circleButton(muted ? "speaker.slash.fill" : "speaker.wave.2.fill") { muted.toggle() }
                        .accessibilityLabel(muted ? "打开声音" : "静音")
                }
                Spacer()
                Text(statusText)
                    .font(.subheadline.weight(.medium))
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(.ultraThinMaterial, in: Capsule())
                    .animation(.default, value: statusText)
            }
            .padding()
        }
        .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
        .onDisappear { UIApplication.shared.isIdleTimerDisabled = false }
        .statusBarHidden()
    }

    private var targets: [ARAlbumTarget] {
        store.memories.map {
            ARAlbumTarget(id: $0.id,
                          title: $0.title,
                          photoURL: store.photoURL(for: $0),
                          videoURL: store.videoURL(for: $0),
                          widthMeters: max($0.widthCM, 1) / 100)
        }
    }

    private var statusText: String {
        if !ARImageTrackingConfiguration.isSupported {
            return "这台设备不支持 AR 图像识别"
        }
        if let problem { return problem }
        if let nowPlaying {
            return nowPlaying.isEmpty ? "正在播放" : "正在播放：\(nowPlaying)"
        }
        return "把手机对准相册里的照片"
    }

    private func circleButton(_ systemName: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 17, weight: .semibold))
                .frame(width: 44, height: 44)
                .background(.ultraThinMaterial, in: Circle())
        }
        .tint(.primary)
    }
}
