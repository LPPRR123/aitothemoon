# 交接文档：回忆相册 AR（iOS App）

更新时间：2026-11-13

这份文档给接手的人（或新的 Claude 会话）看，读完就能接着做，不需要翻之前的聊天记录。

## 一句话说明

用户想要一个 iOS App：用手机对准纸质回忆相册里的照片，照片的位置上直接播放对应的视频，效果像一本会动的书。用户有 Mac，选择做**原生 App**（不做网页版 AR）。

## 现在的状态

| 事项 | 状态 |
|---|---|
| App 代码 | 写完，在 `LPPRR123/aitothemoon` 仓库的 `claude/clever-gauss-clv1p1` 分支，目录 `ios/MemoryAlbumAR/` |
| 编译 | GitHub Actions 的 macOS 机器上模拟器编译通过（两次都成功） |
| 真机测试 | **没做过**。AR 识别、视频贴合、视频方向、声音都还没在 iPhone 上验证 |
| 搬到 `LPPRR123/travel-scrapbook` 仓库 | **没做成**，卡在权限上，见下面“未完成的事” |
| Pull Request | 没开（用户没要求） |

## 未完成的事

### 1. 把 App 放进 `travel-scrapbook` 仓库（用户明确要求，被卡住）

用户给了 `https://github.com/LPPRR123/travel-scrapbook.git`，要求把 App 加进去。会话连接该仓库时被拒绝：没有访问权限（也可能仓库名有误或仓库还没建）。当时会话能访问的仓库只有 `LPPRR123/aitothemoon`。

需要用户先做：

1. 在 https://claude.ai/connect-github 确认 GitHub 账号已连接。
2. 在 https://github.com/apps/claude/installations/select_target 把 Claude GitHub App 的仓库范围加上 `travel-scrapbook`。
3. 如果旧会话仍连不上，新开一个会话并在开始时选中 `travel-scrapbook`。

权限打通后要搬的东西：

- 整个 `ios/MemoryAlbumAR/` 目录
- `.github/workflows/ios-memory-album.yml`（里面的路径是 `ios/MemoryAlbumAR`，如果在新仓库换了位置要一起改）
- `.gitignore` 里新增的 Xcode 几行：`xcuserdata/`、`DerivedData/`、`*.xcuserstate`、`build.log`

还没问过用户的两点：`travel-scrapbook` 里已有什么内容、App 放在哪个目录；搬过去之后 `aitothemoon` 里的这份要不要删掉（它和那个仓库的 Minecraft 机器人无关，只是当时只有这一个仓库可用）。

### 2. 真机验证

用户还没装到手机上。安装步骤在同目录的 `README.md`。装上后重点看：

- 能不能认出相册里的照片（翻拍的图和从手机相册选的原图两种来源都试）
- 视频是否正好盖住照片、跟着照片移动倾斜
- 竖拍视频方向是否正确
- 视频比例和照片不同时，居中裁剪是否符合预期
- 移开后暂停、再对准后继续
- 同一页多张照片同时动时，只有最后出现的那张出声
- 静音按钮；手机拨到静音时视频仍有声音

## App 做了什么

- **首页**：回忆列表，点 + 添加，点一行可改名字和照片宽度或删除，底部“开始扫描相册”。
- **添加回忆**：照片可以用系统扫描相机翻拍（自动找四条边并拉正），也可以从手机相册选原图；再选一段视频；填照片实际宽度（厘米，有 5 寸、6 寸、7 寸快捷按钮）。添加时会让 ARKit 评估这张图好不好认，不好认就显示橙色提示。
- **扫描**：认出照片后视频淡入、循环播放，贴在照片位置上；丢失后暂停并隐藏。最多同时 4 张。
- **数据**：全部存在手机本地 `Documents/Memories/<id>/`（`photo.jpg`、`thumb.jpg`、`video.<扩展名>`），索引是 `Documents/Memories/memories.json`。不联网，不上传。

## 技术要点

- SwiftUI + ARKit（`ARImageTrackingConfiguration`）+ SceneKit + AVFoundation，没有第三方依赖。
- 最低 iOS 17，需要 Xcode 16 或更新。Swift 语言模式是 5（没开 Swift 6 严格并发检查）。
- 工程文件 `project.pbxproj` 是手写的，用了 Xcode 16 的“文件夹同步”方式：`MemoryAlbumAR/` 文件夹里新增或删除 Swift 文件不用改工程文件。
- `Info.plist` 由构建设置自动生成（相机权限说明、显示名“回忆相册”都在 `project.pbxproj` 的 `INFOPLIST_KEY_*` 里）。
- Bundle Identifier 是占位的 `com.example.MemoryAlbumAR`，Team 为空，用户安装前要自己改。
- 参考图是运行时从用户照片生成的（`ARReferenceImage(cgImage, orientation:, physicalWidth:)`），不是打包在工程里的。

各文件作用：

| 文件 | 作用 |
|---|---|
| `MemoryAlbumARApp.swift` | 入口；把音频会话设成 `.playback` |
| `Models/Memory.swift` | 一条回忆的数据 |
| `Models/MemoryStore.swift` | 本地保存、图片转正和缩小 |
| `Views/LibraryView.swift` | 首页、编辑、照片宽度那一栏（添加和编辑共用） |
| `Views/AddMemoryView.swift` | 添加回忆、视频导入、图片质量检查 |
| `Views/DocumentScanner.swift` | 系统扫描相机的包装 |
| `AR/ARScanScreen.swift` | 扫描界面的提示和按钮 |
| `AR/ARAlbumView.swift` | 图像追踪回调、视频平面、播放和声音控制 |

`AR/ARAlbumView.swift` 里几个做法的原因：

- 视频方向：给 `AVPlayerItem` 设了 `videoComposition`，把竖拍视频的旋转信息烤进画面，不依赖 SceneKit 是否处理旋转。
- 铺满照片：用材质的 `contentsTransform` 做居中裁剪。
- 循环：监听播放结束后 seek 回开头（没用 `AVPlayerLooper`，因为不确定它复制模板时会不会保留 `videoComposition`）。循环处可能有极短停顿。
- 线程：ARKit 回调在渲染线程，播放状态都转到主线程改；`lastTracked` 只在渲染线程用。

这几处都只经过编译，没经过真机，真机上出问题先看这里。

## 编译检查（CI）

`.github/workflows/ios-memory-album.yml`：`ios/MemoryAlbumAR/` 下有改动（Markdown 文件除外）时，在 `macos-latest` 上做一次模拟器编译，不签名。

- 第一次用 `macos-15` 时任务排队十多分钟没被接走，改成 `macos-latest` 后一分多钟跑完，之前排队的那次随后也成功了。
- 私有仓库会消耗 Actions 分钟数，Mac 机器按 10 倍计。已告知用户，用户没表态要不要保留。

本会话运行在 Linux 云端容器里，没有 Xcode，不能本地编译 iOS，验证只能靠这个 CI。

## 已做的决定

- 原生 App，不做网页版 AR（用户选的）。
- 照片和视频在 App 里由用户自己配对，不打包进工程。
- 界面文字是中文，直接写在代码里，没做多语言。

## 可以考虑的后续（都没人要求过，做之前先问用户）

- 视频按原比例显示（不裁剪）的选项
- 数据备份或导出（现在删 App 数据就没了）
- 上架或用 TestFlight 分发（需要付费开发者账号）
