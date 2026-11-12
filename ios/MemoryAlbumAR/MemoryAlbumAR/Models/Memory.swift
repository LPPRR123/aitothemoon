import Foundation

/// 一条回忆：相册里的一张照片 + 对准它时要播放的视频。
/// 照片和视频文件放在 Documents/Memories/<id>/ 下，这里只存说明信息。
struct Memory: Identifiable, Codable, Hashable {
    var id = UUID()
    var title: String
    /// 相册里这张照片横向的实际宽度（厘米）。ARKit 用它估算距离。
    var widthCM: Double
    /// 视频文件扩展名（mov / mp4 ...）
    var videoExt: String
    var createdAt = Date()
}
