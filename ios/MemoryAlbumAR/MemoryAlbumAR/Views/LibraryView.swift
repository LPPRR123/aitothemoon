import SwiftUI
import ARKit

/// 首页：回忆列表 + “开始扫描”。
struct LibraryView: View {
    @EnvironmentObject private var store: MemoryStore
    @State private var showAdd = false
    @State private var showScan = false
    @State private var editing: Memory?

    var body: some View {
        NavigationStack {
            Group {
                if store.memories.isEmpty {
                    ContentUnavailableView {
                        Label("还没有回忆", systemImage: "book.pages")
                    } description: {
                        Text("添加一张相册里的照片，再选一段对应的视频。\n之后用手机对准相册，照片就会动起来。")
                    } actions: {
                        Button("添加第一条回忆") { showAdd = true }
                            .buttonStyle(.borderedProminent)
                    }
                } else {
                    List {
                        ForEach(store.memories) { memory in
                            Button {
                                editing = memory
                            } label: {
                                MemoryRow(memory: memory)
                            }
                            .buttonStyle(.plain)
                        }
                        .onDelete { offsets in
                            let targets = offsets.map { store.memories[$0] }
                            for memory in targets {
                                store.delete(memory)
                            }
                        }
                    }
                }
            }
            .navigationTitle("回忆相册")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        showAdd = true
                    } label: {
                        Label("添加", systemImage: "plus")
                    }
                }
            }
            .safeAreaInset(edge: .bottom) {
                if !store.memories.isEmpty {
                    Button {
                        showScan = true
                    } label: {
                        Label("开始扫描相册", systemImage: "viewfinder")
                            .font(.headline)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 6)
                    }
                    .buttonStyle(.borderedProminent)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 12)
                    .background(.bar)
                }
            }
            .sheet(isPresented: $showAdd) {
                AddMemoryView()
            }
            .sheet(item: $editing) { memory in
                EditMemoryView(memory: memory)
            }
            .fullScreenCover(isPresented: $showScan) {
                ARScanScreen()
            }
        }
    }
}

private struct MemoryRow: View {
    @EnvironmentObject private var store: MemoryStore
    let memory: Memory

    var body: some View {
        HStack(spacing: 14) {
            Group {
                if let image = store.thumbnail(for: memory) {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFill()
                } else {
                    Color.secondary.opacity(0.2)
                }
            }
            .frame(width: 72, height: 72)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay(alignment: .bottomTrailing) {
                Image(systemName: "play.circle.fill")
                    .font(.system(size: 20))
                    .foregroundStyle(.white)
                    .shadow(radius: 2)
                    .padding(4)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(memory.title.isEmpty ? "未命名回忆" : memory.title)
                    .font(.headline)
                Text("照片宽 \(memory.widthCM.formatted(.number.precision(.fractionLength(0...1)))) 厘米")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
    }
}

/// 修改名字 / 照片宽度，或删除。
private struct EditMemoryView: View {
    @EnvironmentObject private var store: MemoryStore
    @Environment(\.dismiss) private var dismiss
    @State var memory: Memory
    @State private var confirmDelete = false

    var body: some View {
        NavigationStack {
            Form {
                if let image = UIImage(contentsOfFile: store.photoURL(for: memory).path) {
                    Section {
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFit()
                            .frame(maxHeight: 220)
                            .frame(maxWidth: .infinity)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                    }
                }
                Section("名字") {
                    TextField("例如：2019 年海边", text: $memory.title)
                }
                PhotoWidthSection(widthCM: $memory.widthCM)
                Section {
                    Button("删除这条回忆", role: .destructive) { confirmDelete = true }
                }
            }
            .navigationTitle("编辑回忆")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        store.update(memory)
                        dismiss()
                    }
                }
            }
            .confirmationDialog("删除后照片和视频会从这个 App 里移除（不影响系统相册）。", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("删除", role: .destructive) {
                    store.delete(memory)
                    dismiss()
                }
                Button("取消", role: .cancel) {}
            }
        }
    }
}

/// 填写照片实际宽度的那一栏，添加和编辑共用。
struct PhotoWidthSection: View {
    @Binding var widthCM: Double

    private let presets: [(String, Double)] = [("5 寸横", 12.7), ("6 寸横", 15.2), ("7 寸横", 17.8), ("6 寸竖", 10.2)]

    var body: some View {
        Section {
            HStack {
                Text("照片宽度")
                Spacer()
                TextField("宽度", value: $widthCM, format: .number.precision(.fractionLength(0...1)))
                    .keyboardType(.decimalPad)
                    .multilineTextAlignment(.trailing)
                    .frame(width: 80)
                Text("厘米")
                    .foregroundStyle(.secondary)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                HStack {
                    ForEach(presets, id: \.0) { preset in
                        Button(preset.0) { widthCM = preset.1 }
                            .buttonStyle(.bordered)
                            .buttonBorderShape(.capsule)
                            .tint(abs(widthCM - preset.1) < 0.05 ? .accentColor : .secondary)
                    }
                }
            }
        } header: {
            Text("相册里这张照片有多宽")
        } footer: {
            Text("量一下相册里照片左右两边的距离，大概准就行。")
        }
    }
}

#Preview {
    LibraryView()
        .environmentObject(MemoryStore())
}
