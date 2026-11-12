import SwiftUI
import UIKit

/// 保存所有回忆。数据全部留在手机本地（App 的 Documents 目录）。
@MainActor
final class MemoryStore: ObservableObject {
    @Published private(set) var memories: [Memory] = []

    private let root: URL
    private var indexURL: URL { root.appendingPathComponent("memories.json") }

    init() {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        root = documents.appendingPathComponent("Memories", isDirectory: true)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        load()
    }

    // MARK: - 文件位置

    func folder(for memory: Memory) -> URL {
        root.appendingPathComponent(memory.id.uuidString, isDirectory: true)
    }

    func photoURL(for memory: Memory) -> URL {
        folder(for: memory).appendingPathComponent("photo.jpg")
    }

    func thumbnailURL(for memory: Memory) -> URL {
        folder(for: memory).appendingPathComponent("thumb.jpg")
    }

    func videoURL(for memory: Memory) -> URL {
        folder(for: memory).appendingPathComponent("video").appendingPathExtension(memory.videoExt)
    }

    func thumbnail(for memory: Memory) -> UIImage? {
        UIImage(contentsOfFile: thumbnailURL(for: memory).path)
    }

    // MARK: - 增删改

    /// 新增一条回忆。`videoURL` 是临时文件，会被移动进 App 目录。
    func add(title: String, photo: UIImage, videoURL: URL, widthCM: Double) throws {
        let ext = videoURL.pathExtension.isEmpty ? "mov" : videoURL.pathExtension.lowercased()
        let memory = Memory(title: title, widthCM: widthCM, videoExt: ext)
        let dir = folder(for: memory)
        let fm = FileManager.default
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)

        do {
            let full = Self.normalized(photo, maxSide: 1600)
            let thumb = Self.normalized(photo, maxSide: 320)
            guard let fullData = full.jpegData(compressionQuality: 0.9),
                  let thumbData = thumb.jpegData(compressionQuality: 0.8) else {
                throw CocoaError(.fileWriteUnknown)
            }
            try fullData.write(to: photoURL(for: memory), options: .atomic)
            try thumbData.write(to: thumbnailURL(for: memory), options: .atomic)

            let dest = self.videoURL(for: memory)
            do {
                try fm.moveItem(at: videoURL, to: dest)
            } catch {
                try fm.copyItem(at: videoURL, to: dest)
            }
        } catch {
            try? fm.removeItem(at: dir)
            throw error
        }

        memories.insert(memory, at: 0)
        save()
    }

    func update(_ memory: Memory) {
        guard let index = memories.firstIndex(where: { $0.id == memory.id }) else { return }
        memories[index] = memory
        save()
    }

    func delete(_ memory: Memory) {
        memories.removeAll { $0.id == memory.id }
        try? FileManager.default.removeItem(at: folder(for: memory))
        save()
    }

    // MARK: - 读写索引

    private func load() {
        guard let data = try? Data(contentsOf: indexURL),
              let list = try? JSONDecoder().decode([Memory].self, from: data) else { return }
        memories = list
    }

    private func save() {
        guard let data = try? JSONEncoder().encode(memories) else { return }
        try? data.write(to: indexURL, options: .atomic)
    }

    // MARK: - 图片处理

    /// 把图片转正（去掉 EXIF 方向）并缩小到最长边不超过 `maxSide` 像素。
    nonisolated static func normalized(_ image: UIImage, maxSide: CGFloat = 1600) -> UIImage {
        let size = image.size
        guard size.width > 0, size.height > 0 else { return image }
        let scale = min(1, maxSide / max(size.width, size.height))
        let target = CGSize(width: (size.width * scale).rounded(), height: (size.height * scale).rounded())
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        return UIGraphicsImageRenderer(size: target, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
    }
}
