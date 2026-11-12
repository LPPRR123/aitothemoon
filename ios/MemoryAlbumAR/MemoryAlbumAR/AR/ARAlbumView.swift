import SwiftUI
import ARKit
import SceneKit
import AVFoundation

/// 一张要识别的照片和它对应的视频。
struct ARAlbumTarget {
    let id: UUID
    let title: String
    let photoURL: URL
    let videoURL: URL
    let widthMeters: Double
}

/// ARKit 相机画面。认出相册里的照片后，在照片的位置贴上一块正在播放视频的平面，
/// 平面会跟着照片一起移动、倾斜，看起来就像照片自己动了起来。
struct ARAlbumView: UIViewRepresentable {
    let targets: [ARAlbumTarget]
    let muted: Bool
    @Binding var nowPlaying: String?
    @Binding var problem: String?

    func makeCoordinator() -> Coordinator {
        Coordinator(targets: targets, nowPlaying: $nowPlaying, problem: $problem)
    }

    func makeUIView(context: Context) -> ARSCNView {
        let view = ARSCNView(frame: .zero)
        view.scene = SCNScene()
        view.automaticallyUpdatesLighting = false
        view.delegate = context.coordinator
        context.coordinator.muted = muted
        context.coordinator.start(in: view)
        return view
    }

    func updateUIView(_ uiView: ARSCNView, context: Context) {
        context.coordinator.muted = muted
    }

    static func dismantleUIView(_ uiView: ARSCNView, coordinator: Coordinator) {
        uiView.session.pause()
        coordinator.stopAll()
    }

    // MARK: - Coordinator

    final class Coordinator: NSObject, ARSCNViewDelegate {
        /// 同一页上最多同时让几张照片动起来（ARKit 上限是 4）。
        private static let maxSimultaneous = 4

        private let targets: [UUID: ARAlbumTarget]
        private let nowPlaying: Binding<String?>
        private let problem: Binding<String?>

        /// 以下状态只在主线程上读写。
        private var playbacks: [UUID: Playback] = [:]   // key: ARAnchor.identifier
        private var appearOrder: [UUID] = []            // 当前看得见的照片，最后出现的排最后
        var muted = false { didSet { applyAudio() } }

        /// 只在 SceneKit 渲染线程上读写。
        private var lastTracked: [UUID: Bool] = [:]

        init(targets: [ARAlbumTarget], nowPlaying: Binding<String?>, problem: Binding<String?>) {
            self.targets = Dictionary(targets.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            self.nowPlaying = nowPlaying
            self.problem = problem
        }

        /// 把所有照片交给 ARKit，然后开始追踪。
        func start(in view: ARSCNView) {
            let list = Array(targets.values)
            DispatchQueue.global(qos: .userInitiated).async {
                var images = Set<ARReferenceImage>()
                for target in list {
                    guard let image = UIImage(contentsOfFile: target.photoURL.path)?.cgImage else { continue }
                    let reference = ARReferenceImage(image, orientation: .up, physicalWidth: CGFloat(target.widthMeters))
                    reference.name = target.id.uuidString
                    images.insert(reference)
                }
                DispatchQueue.main.async {
                    let configuration = ARImageTrackingConfiguration()
                    configuration.trackingImages = images
                    configuration.maximumNumberOfTrackedImages = min(Self.maxSimultaneous, max(images.count, 1))
                    view.session.run(configuration, options: [.resetTracking, .removeExistingAnchors])
                }
            }
        }

        func stopAll() {
            for playback in playbacks.values {
                playback.stop()
            }
            playbacks.removeAll()
            appearOrder.removeAll()
        }

        // MARK: ARSCNViewDelegate（在渲染线程上被调用）

        func renderer(_ renderer: SCNSceneRenderer, didAdd node: SCNNode, for anchor: ARAnchor) {
            guard let imageAnchor = anchor as? ARImageAnchor,
                  let name = imageAnchor.referenceImage.name,
                  let id = UUID(uuidString: name),
                  let target = targets[id] else { return }

            let size = imageAnchor.referenceImage.physicalSize
            lastTracked[anchor.identifier] = true
            DispatchQueue.main.async {
                self.addPlayback(for: target, anchorID: anchor.identifier, size: size, on: node)
            }
        }

        func renderer(_ renderer: SCNSceneRenderer, didUpdate node: SCNNode, for anchor: ARAnchor) {
            guard let imageAnchor = anchor as? ARImageAnchor else { return }
            let tracked = imageAnchor.isTracked
            guard lastTracked[anchor.identifier] != tracked else { return }
            lastTracked[anchor.identifier] = tracked
            DispatchQueue.main.async {
                self.setVisible(tracked, anchorID: anchor.identifier)
            }
        }

        func renderer(_ renderer: SCNSceneRenderer, didRemove node: SCNNode, for anchor: ARAnchor) {
            lastTracked[anchor.identifier] = nil
            DispatchQueue.main.async {
                self.playbacks[anchor.identifier]?.stop()
                self.playbacks[anchor.identifier] = nil
                self.appearOrder.removeAll { $0 == anchor.identifier }
                self.refreshStatus()
            }
        }

        func session(_ session: ARSession, didFailWithError error: Error) {
            let message: String
            if let arError = error as? ARError, arError.code == .cameraUnauthorized {
                message = "没有相机权限。请到“设置 → 回忆相册”里打开相机。"
            } else {
                message = "相机启动失败：\(error.localizedDescription)"
            }
            DispatchQueue.main.async { self.problem.wrappedValue = message }
        }

        func sessionWasInterrupted(_ session: ARSession) {
            DispatchQueue.main.async {
                for id in self.appearOrder {
                    self.playbacks[id]?.setVisible(false)
                }
                self.appearOrder.removeAll()
                self.refreshStatus()
            }
        }

        // MARK: 播放控制（主线程）

        private func addPlayback(for target: ARAlbumTarget, anchorID: UUID, size: CGSize, on node: SCNNode) {
            guard playbacks[anchorID] == nil else { return }
            let playback = Playback(target: target, size: size)
            playbacks[anchorID] = playback
            node.addChildNode(playback.node)
            setVisible(true, anchorID: anchorID)
        }

        private func setVisible(_ visible: Bool, anchorID: UUID) {
            guard let playback = playbacks[anchorID] else { return }
            appearOrder.removeAll { $0 == anchorID }
            if visible {
                appearOrder.append(anchorID)
            }
            playback.setVisible(visible)
            refreshStatus()
        }

        private func refreshStatus() {
            applyAudio()
            if let current = appearOrder.last, let playback = playbacks[current] {
                nowPlaying.wrappedValue = playback.target.title
            } else {
                nowPlaying.wrappedValue = nil
            }
        }

        /// 同时有几张照片在动时，只让最后出现的那张出声，免得声音叠在一起。
        private func applyAudio() {
            let audible = muted ? nil : appearOrder.last
            for (id, playback) in playbacks {
                playback.player.isMuted = (id != audible)
            }
        }
    }
}

// MARK: - 一块正在播放视频的平面

private final class Playback {
    let target: ARAlbumTarget
    let node: SCNNode
    let player: AVPlayer

    private let plane: SCNPlane
    private var loopObserver: NSObjectProtocol?
    private var wantsToPlay = false
    private var ready = false

    init(target: ARAlbumTarget, size: CGSize) {
        self.target = target
        player = AVPlayer()
        player.isMuted = true
        player.actionAtItemEnd = .none

        plane = SCNPlane(width: size.width, height: size.height)
        let material = SCNMaterial()
        material.lightingModel = .constant
        material.isDoubleSided = true
        material.diffuse.contents = UIColor.black
        material.diffuse.wrapS = .clamp
        material.diffuse.wrapT = .clamp
        plane.materials = [material]

        node = SCNNode(geometry: plane)
        // SCNPlane 默认是竖着的，ARKit 的照片锚点是平躺的（法线朝 +Y），转 90° 让它贴在照片上
        node.eulerAngles.x = -.pi / 2
        node.opacity = 0

        Task { @MainActor [weak self] in
            await self?.prepare(photoSize: size)
        }
    }

    /// 读取视频、摆正方向、按“铺满照片”的方式裁剪，然后开始播放。
    @MainActor
    private func prepare(photoSize: CGSize) async {
        let asset = AVURLAsset(url: target.videoURL)
        let item = AVPlayerItem(asset: asset)
        var videoSize = CGSize.zero

        // 用 videoComposition 把竖拍视频的旋转信息“烤”进画面，保证贴上去是正的
        if let composition = try? await AVVideoComposition.videoComposition(withPropertiesOf: asset) {
            item.videoComposition = composition
            videoSize = composition.renderSize
        } else if let track = try? await asset.loadTracks(withMediaType: .video).first,
                  let natural = try? await track.load(.naturalSize) {
            videoSize = natural
        }

        if let material = plane.firstMaterial {
            material.diffuse.contentsTransform = Self.aspectFill(video: videoSize, photo: photoSize)
            material.diffuse.contents = player
        }

        loopObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            self.player.seek(to: .zero)
            if self.wantsToPlay { self.player.play() }
        }

        player.replaceCurrentItem(with: item)
        ready = true
        if wantsToPlay { player.play() }
    }

    func setVisible(_ visible: Bool) {
        wantsToPlay = visible
        node.removeAllActions()
        if visible {
            node.isHidden = false
            node.runAction(.fadeIn(duration: 0.35))
            if ready { player.play() }
        } else {
            player.pause()
            node.opacity = 0
            node.isHidden = true
        }
    }

    func stop() {
        wantsToPlay = false
        player.pause()
        player.replaceCurrentItem(with: nil)
        if let loopObserver {
            NotificationCenter.default.removeObserver(loopObserver)
        }
        loopObserver = nil
        node.removeFromParentNode()
    }

    /// 视频和照片比例不一样时，居中裁掉多出来的部分，让视频正好盖住照片。
    private static func aspectFill(video: CGSize, photo: CGSize) -> SCNMatrix4 {
        guard video.width > 0, video.height > 0, photo.width > 0, photo.height > 0 else {
            return SCNMatrix4Identity
        }
        let videoAspect = video.width / video.height
        let photoAspect = photo.width / photo.height
        var scaleX: CGFloat = 1
        var scaleY: CGFloat = 1
        if videoAspect > photoAspect {
            scaleX = photoAspect / videoAspect   // 视频更宽：裁左右
        } else {
            scaleY = videoAspect / photoAspect   // 视频更高：裁上下
        }
        let scale = SCNMatrix4MakeScale(Float(scaleX), Float(scaleY), 1)
        let offset = SCNMatrix4MakeTranslation(Float((1 - scaleX) / 2), Float((1 - scaleY) / 2), 0)
        return SCNMatrix4Mult(scale, offset)
    }
}
