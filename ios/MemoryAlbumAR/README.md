# 回忆相册 AR（iOS App）

用 iPhone 对准相册里的照片，照片的位置上会直接播放对应的视频，视频会跟着照片一起移动、倾斜，像一本会动的书。

这个 App 和仓库里的 Minecraft 机器人没有关系，只是放在同一个仓库的 `ios/MemoryAlbumAR/` 目录下。

## 怎么用

1. 打开 App，点右上角 **+** 添加一条回忆：
   - **① 相册里的照片**：点“翻拍相册里的照片”，对准相册里那张照片拍一下（会自动找到四条边并拉正）；如果手机里有这张照片的原图，也可以直接从手机相册选。
   - **② 视频**：从手机相册选对准它时要播放的视频。
   - **照片宽度**：相册里这张照片左右有多宽（厘米），大概准就行。
2. 每张想“动起来”的照片都添加一条。
3. 点 **开始扫描相册**，把手机对准相册。认出照片后视频会淡入并循环播放，移开后自动暂停。

同一页最多可以同时让 4 张照片动起来；这时只有最后出现的那张有声音。右上角可以静音。

所有照片和视频只保存在手机本地，不会上传到任何地方。

## 安装到 iPhone

需要：一台 Mac、Xcode 16 或更新版本、iPhone（iOS 17 或更新）、一根数据线、一个 Apple ID。

1. 在 Mac 上用 Xcode 打开 `ios/MemoryAlbumAR/MemoryAlbumAR.xcodeproj`。
2. 左侧点最上面的蓝色工程图标 → 中间选 **TARGETS → MemoryAlbumAR** → **Signing & Capabilities**：
   - **Team** 选你自己的 Apple ID（没有就点 *Add an Account…* 登录）。
   - **Bundle Identifier** 把 `com.example.MemoryAlbumAR` 改成一个独一无二的名字，比如 `com.你的名字.MemoryAlbumAR`。
3. 用数据线把 iPhone 连到 Mac，在 iPhone 上点“信任”。第一次还需要在 iPhone 上打开 **设置 → 隐私与安全性 → 开发者模式**，然后重启手机。
4. Xcode 顶部的设备列表里选你的 iPhone，点左上角的 ▶ 运行。
5. 第一次打开 App 时如果提示“不受信任的开发者”：iPhone 上 **设置 → 通用 → VPN 与设备管理** → 点你的 Apple ID → 信任。

免费 Apple ID 装的 App 7 天后会过期，过期后重新连上 Mac 点一次 ▶ 就行，App 里的数据不会丢。付费开发者账号（每年 99 美元）装的可以用一年。

AR 功能必须在真机上用，Xcode 的模拟器没有相机，只能看界面。

## 识别效果不好时

- 光线要够亮，照片表面不要有大片反光（带塑料膜的相册稍微倾斜一点）。
- 细节丰富的照片最好认；大片天空、白墙、很暗或很糊的照片不容易认。添加时如果出现橙色提示，说明这张图不太好认。
- 翻拍时只框住照片本身，不要带进相册的边框和旁边的照片。
- 两张几乎一样的照片会互相认错。

## 代码结构

| 文件 | 作用 |
|---|---|
| `MemoryAlbumARApp.swift` | App 入口 |
| `Models/Memory.swift`、`Models/MemoryStore.swift` | 回忆的数据和本地保存 |
| `Views/LibraryView.swift` | 首页列表、编辑 |
| `Views/AddMemoryView.swift` | 添加回忆（选照片、选视频） |
| `Views/DocumentScanner.swift` | 翻拍相册照片用的系统扫描相机 |
| `AR/ARScanScreen.swift` | 扫描界面 |
| `AR/ARAlbumView.swift` | ARKit 图像追踪 + 把视频贴到照片上 |

用的是苹果自带的 ARKit 图像追踪（`ARImageTrackingConfiguration`），没有任何第三方依赖。

`.github/workflows/ios-memory-album.yml` 会在这个目录有改动时（Markdown 文件除外），用 GitHub 的 macOS 机器编译一遍，确认代码能编过。

接手这个项目请先看 [HANDOFF.md](HANDOFF.md)。
