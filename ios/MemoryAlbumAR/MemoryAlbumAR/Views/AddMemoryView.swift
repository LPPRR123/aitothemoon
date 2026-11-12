import SwiftUI
import PhotosUI
import ARKit
import AVFoundation
import UniformTypeIdentifiers

/// 从系统相册里选出来的视频，拷贝到临时目录。
struct PickedVideo: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .movie) { video in
            SentTransferredFile(video.url)
        } importing: { received in
            let ext = received.file.pathExtension.isEmpty ? "mov" : received.file.pathExtension
            let dest = FileManager.default.temporaryDirectory
                .appendingPathComponent(UUID().uuidString)
                .appendingPathExtension(ext)
            try FileManager.default.copyItem(at: received.file, to: dest)
            return PickedVideo(url: dest)
        }
    }
}

/// 添加一条回忆：选照片（或翻拍相册）+ 选视频。
struct AddMemoryView: View {
    @EnvironmentObject private var store: MemoryStore
    @Environment(\.dismiss) private var dismiss

    @State private var title = ""
    @State private var widthCM: Double = 15.2

    @State private var photo: UIImage?
    @State private var photoItem: PhotosPickerItem?
    @State private var showScanner = false
    @State private var qualityWarning: String?

    @State private var videoItem: PhotosPickerItem?
    @State private var videoURL: URL?
    @State private var videoPoster: UIImage?
    @State private var loadingVideo = false

    @State private var saving = false
    @State private var errorMessage: String?

    private var canSave: Bool { photo != nil && videoURL != nil && widthCM > 0 && !saving }

    var body: some View {
        NavigationStack {
            Form {
                photoSection
                videoSection
                Section("名字（可不填）") {
                    TextField("例如：2019 年海边", text: $title)
                }
                PhotoWidthSection(widthCM: $widthCM)
            }
            .navigationTitle("添加回忆")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") {
                        cleanupTempVideo()
                        dismiss()
                    }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") { save() }
                        .disabled(!canSave)
                }
            }
            .fullScreenCover(isPresented: $showScanner) {
                DocumentScanner { image in
                    showScanner = false
                    if let image { setPhoto(image) }
                }
                .ignoresSafeArea()
            }
            .onChange(of: photoItem) { _, item in
                guard let item else { return }
                Task {
                    if let data = try? await item.loadTransferable(type: Data.self),
                       let image = UIImage(data: data) {
                        setPhoto(image)
                    } else {
                        errorMessage = "这张照片读取失败，换一张试试。"
                    }
                }
            }
            .onChange(of: videoItem) { _, item in
                guard let item else { return }
                loadVideo(item)
            }
            .alert("出了点问题", isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })) {
                Button("好") {}
            } message: {
                Text(errorMessage ?? "")
            }
        }
    }

    // MARK: - 照片

    private var photoSection: some View {
        Section {
            if let photo {
                Image(uiImage: photo)
                    .resizable()
                    .scaledToFit()
                    .frame(maxHeight: 220)
                    .frame(maxWidth: .infinity)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
            }
            if DocumentScanner.isSupported {
                Button {
                    showScanner = true
                } label: {
                    Label("翻拍相册里的照片", systemImage: "camera.viewfinder")
                }
            }
            PhotosPicker(selection: $photoItem, matching: .images) {
                Label("从手机相册选原图", systemImage: "photo.on.rectangle")
            }
            if let qualityWarning {
                Label(qualityWarning, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }
        } header: {
            Text("① 相册里的照片")
        } footer: {
            Text("这张图就是之后要用手机对准的那张照片。翻拍时只框住照片本身，尽量别反光。")
        }
    }

    private func setPhoto(_ image: UIImage) {
        let fixed = MemoryStore.normalized(image, maxSide: 1600)
        photo = fixed
        qualityWarning = nil
        Task { await checkQuality(fixed) }
    }

    /// 让 ARKit 评估这张图好不好识别（纯色、太糊、细节太少的图识别不稳）。
    private func checkQuality(_ image: UIImage) async {
        guard let cgImage = image.cgImage else { return }
        let reference = ARReferenceImage(cgImage, orientation: .up, physicalWidth: 0.15)
        do {
            try await reference.validate()
        } catch {
            if photo === image {
                qualityWarning = "这张图细节偏少或不够清晰，扫描时可能不容易认出来。可以换一张更清楚、内容更丰富的。"
            }
        }
    }

    // MARK: - 视频

    private var videoSection: some View {
        Section {
            if loadingVideo {
                HStack {
                    ProgressView()
                    Text("正在读取视频…").foregroundStyle(.secondary)
                }
            } else if let videoPoster {
                Image(uiImage: videoPoster)
                    .resizable()
                    .scaledToFit()
                    .frame(maxHeight: 180)
                    .frame(maxWidth: .infinity)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .overlay {
                        Image(systemName: "play.circle.fill")
                            .font(.system(size: 44))
                            .foregroundStyle(.white.opacity(0.9))
                            .shadow(radius: 4)
                    }
            }
            PhotosPicker(selection: $videoItem, matching: .videos) {
                Label(videoURL == nil ? "选择视频" : "换一段视频", systemImage: "film")
            }
        } header: {
            Text("② 对准它时播放的视频")
        } footer: {
            Text("视频会铺满照片的位置。横照片配横视频、竖照片配竖视频效果最好。")
        }
    }

    private func loadVideo(_ item: PhotosPickerItem) {
        loadingVideo = true
        Task {
            defer { loadingVideo = false }
            do {
                guard let picked = try await item.loadTransferable(type: PickedVideo.self) else {
                    errorMessage = "这段视频读取失败，换一段试试。"
                    return
                }
                cleanupTempVideo()
                videoURL = picked.url
                videoPoster = await Self.poster(for: picked.url)
            } catch {
                errorMessage = "这段视频读取失败：\(error.localizedDescription)"
            }
        }
    }

    private static func poster(for url: URL) async -> UIImage? {
        let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 800, height: 800)
        guard let result = try? await generator.image(at: .zero) else { return nil }
        return UIImage(cgImage: result.image)
    }

    private func cleanupTempVideo() {
        if let videoURL {
            try? FileManager.default.removeItem(at: videoURL)
        }
        videoURL = nil
        videoPoster = nil
    }

    // MARK: - 保存

    private func save() {
        guard let photo, let videoURL else { return }
        saving = true
        do {
            try store.add(title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                          photo: photo,
                          videoURL: videoURL,
                          widthCM: widthCM)
            dismiss()
        } catch {
            saving = false
            errorMessage = "保存失败：\(error.localizedDescription)"
        }
    }
}
