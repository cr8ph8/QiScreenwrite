import SwiftUI
import UIKit
import ScreenwriteCore

private enum WritingMode: String, CaseIterable { case pages = "Pages", fountain = "Fountain" }
private struct WriterCommand: Equatable {
    enum Action: Equatable { case element(ScreenplayElement), dismiss }
    var id = UUID()
    var action: Action
}

/// A page is a lossless source window. Its range stays fixed during an editing
/// session; reflow happens at navigation/dismissal, never underneath the caret.
struct WritingView: View {
    @Binding var bodyText: String
    var onEditingChanged: (Bool) -> Void = { _ in }
    @State private var mode = WritingMode.pages
    @State private var pages: [ScreenplayPage] = []
    @State private var pageIndex = 0
    @State private var windowRange = NSRange(location: 0, length: 0)
    @State private var windowText = ""
    @State private var knownSource = ""
    @State private var generation = UUID()
    @State private var editing = false
    @State private var command: WriterCommand?
    @State private var pagePicker = false
    @State private var selection = NSRange(location: 0, length: 0)
    @State private var sourceBefore = ""
    @State private var sourceAfter = ""

    var body: some View {
        VStack(spacing: 0) {
            pageControls
            NativePageEditor(text: Binding(get: { windowText }, set: replaceWindow),
                             sourceMode: mode == .fountain, generation: generation,
                             sourceBefore: sourceBefore, sourceAfter: sourceAfter, command: command,
                             initialSelection: selection,
                             maximumLength: 200_000 - bodyText.utf16.count + windowText.utf16.count,
                             onFocus: focusChanged, onSelection: { range, origin in
                                 if origin == generation { selection = range }
                             })
                .background(mode == .pages ? Color(red: 0.99, green: 0.98, blue: 0.95) : Color(uiColor: .secondarySystemBackground))
                .clipShape(RoundedRectangle(cornerRadius: editing ? 0 : 8))
                .padding(.horizontal, editing ? 0 : 10)
                .padding(.top, editing ? 0 : 8)
            if !editing {
                HStack(spacing: 8) {
                    Image(systemName: "doc.text")
                    Text(mode == .pages ? "Draft pages · tap the paper to write" : "Fountain source · original text")
                    Spacer(minLength: 0)
                    Text("\(bodyText.utf16.count.formatted()) characters").monospacedDigit()
                }.font(.caption2).foregroundStyle(.secondary).padding(.horizontal, 14).padding(.vertical, 9)
            }
        }
        .background(Color(uiColor: .systemGroupedBackground))
        .onAppear { refresh(anchor: 0) }
        .onChange(of: bodyText) { _, value in
            // A history restore or a different source must not use a stale range.
            if value != knownSource { refresh(anchor: min(windowRange.location, value.utf16.count)) }
        }
        .onDisappear { onEditingChanged(false) }
        .sheet(isPresented: $pagePicker) {
            NavigationStack {
                List(Array(pages.enumerated()), id: \.offset) { index, page in
                    Button {
                        selectPage(index); pagePicker = false
                    } label: {
                        HStack(alignment: .top, spacing: 14) {
                            Text("\(page.number)").font(.headline.monospaced()).frame(width: 32)
                            Text(page.text.split(whereSeparator: \.isNewline).first.map(String.init) ?? "Blank page")
                                .font(.subheadline).lineLimit(2).foregroundStyle(.primary)
                            Spacer()
                            if index == pageIndex { Image(systemName: "checkmark").foregroundStyle(.tint) }
                        }.padding(.vertical, 5)
                    }.accessibilityLabel("Go to page \(page.number)")
                }
                .navigationTitle("Screenplay pages").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { pagePicker = false } } }
            }.presentationDetents([.medium, .large])
        }
    }

    private var pageControls: some View {
        HStack(spacing: 8) {
            Menu {
                ForEach(WritingMode.allCases, id: \.self) { value in
                    Button { switchMode(value) } label: {
                        if value == mode { Label(value.rawValue, systemImage: "checkmark") } else { Text(value.rawValue) }
                    }
                }
            } label: { Label(mode.rawValue, systemImage: mode == .pages ? "doc.richtext" : "chevron.left.forwardslash.chevron.right").font(.subheadline.weight(.semibold)) }
                .accessibilityLabel("Writing view").accessibilityIdentifier("writing-view-mode")
            Spacer(minLength: 4)
            if mode == .pages {
                Button { selectPage(pageIndex - 1) } label: { Image(systemName: "chevron.left").frame(width: 36, height: 40) }
                    .disabled(pageIndex <= 0).accessibilityLabel("Previous page")
                Button { command = .init(action: .dismiss); repaginate(); pagePicker = true } label: {
                    Text("\(pageIndex + 1) / \(max(pages.count, 1))").font(.subheadline.monospacedDigit().weight(.medium)).frame(minWidth: 55, minHeight: 40)
                }.accessibilityLabel("Page \(pageIndex + 1) of \(max(pages.count, 1))").accessibilityIdentifier("page-picker")
                Button { selectPage(pageIndex + 1) } label: { Image(systemName: "chevron.right").frame(width: 36, height: 40) }
                    .disabled(pageIndex + 1 >= pages.count).accessibilityLabel("Next page")
            } else { Text("Source").font(.caption).foregroundStyle(.secondary) }
        }.padding(.horizontal, 12).frame(height: 44).background(.thinMaterial)
    }

    private func replaceWindow(_ value: String) {
        let original = bodyText as NSString
        guard windowRange.location >= 0, NSMaxRange(windowRange) <= original.length else { return }
        let changed = original.replacingCharacters(in: windowRange, with: value)
        guard changed.utf16.count <= 200_000 else { return }
        windowText = value; windowRange.length = value.utf16.count
        knownSource = changed; bodyText = changed
    }
    private func repaginate() { pages = ScreenplayPagination.pages(in: bodyText) }
    private func refresh(anchor: Int) {
        let previousRange = windowRange, previousText = windowText
        let externalChange = knownSource != bodyText
        knownSource = bodyText; repaginate()
        if mode == .fountain {
            windowRange = NSRange(location: 0, length: bodyText.utf16.count); windowText = bodyText
            sourceBefore = ""; sourceAfter = ""
        } else {
            let index = pages.lastIndex(where: { $0.sourceRange.location <= anchor }) ?? 0
            loadPage(index)
        }
        selection = NSRange(location: max(0, min(anchor - windowRange.location, windowRange.length)), length: 0)
        // Keep native undo/caret state when dismissing the keyboard did not
        // actually change the source window. New windows get isolated undo.
        if externalChange || previousRange != windowRange || previousText != windowText { generation = UUID() }
    }
    private func loadPage(_ index: Int) {
        guard !pages.isEmpty else { windowText = ""; windowRange = NSRange(location: 0, length: 0); return }
        pageIndex = max(0, min(index, pages.count - 1))
        let page = pages[pageIndex]; windowRange = page.sourceRange; windowText = page.text
        let source = bodyText as NSString
        sourceBefore = source.substring(to: windowRange.location)
        sourceAfter = source.substring(from: NSMaxRange(windowRange))
    }
    private func selectPage(_ index: Int) {
        command = .init(action: .dismiss); repaginate(); loadPage(index)
        selection = NSRange(location: 0, length: 0); generation = UUID()
    }
    private func switchMode(_ value: WritingMode) {
        guard value != mode else { return }
        let anchor = windowRange.location + selection.location
        command = .init(action: .dismiss); mode = value; refresh(anchor: anchor)
    }
    private func focusChanged(_ focused: Bool, origin: UUID, caret: NSRange) {
        if focused && origin != generation { return }
        editing = focused; onEditingChanged(focused)
        if !focused && origin == generation {
            let anchor = windowRange.location + caret.location
            refresh(anchor: min(anchor, bodyText.utf16.count))
        }
    }
}

private struct NativePageEditor: UIViewRepresentable {
    @Binding var text: String
    var sourceMode: Bool
    var generation: UUID
    var sourceBefore: String
    var sourceAfter: String
    var command: WriterCommand?
    var initialSelection: NSRange
    var maximumLength: Int
    var onFocus: (Bool, UUID, NSRange) -> Void
    var onSelection: (NSRange, UUID) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> ScreenplayTextView {
        let view = ScreenplayTextView()
        view.delegate = context.coordinator; context.coordinator.view = view
        view.backgroundColor = .clear; view.keyboardDismissMode = .interactive
        view.smartQuotesType = .no; view.smartDashesType = .no
        // Keep screenplay cues/prefixes literal; spelling suggestions remain
        // available without silently replacing character names or INT./EXT.
        view.autocorrectionType = .no; view.spellCheckingType = .yes
        view.smartInsertDeleteType = .no; view.textContainer.lineFragmentPadding = 0
        view.alwaysBounceVertical = true; view.tintColor = UIColor(red: 0.58, green: 0.39, blue: 0.09, alpha: 1)
        view.accessibilityIdentifier = "screenplay-editor"
        view.inputAssistantItem.leadingBarButtonGroups = []; view.inputAssistantItem.trailingBarButtonGroups = []
        view.onWidthChange = { [weak coordinator = context.coordinator] in coordinator?.style() }
        view.onTab = { [weak coordinator = context.coordinator] in coordinator?.cycleElement() }
        context.coordinator.configureAccessory()
        return view
    }
    func updateUIView(_ view: ScreenplayTextView, context: Context) {
        let coordinator = context.coordinator; coordinator.parent = self
        if let command, coordinator.lastCommand != command.id {
            coordinator.lastCommand = command.id
            switch command.action {
            case .dismiss: view.resignFirstResponder()
            case .element(let type): coordinator.changeElement(type)
            }
        }
        let reset = coordinator.generation != generation
        if reset || (view.text != text && view.markedTextRange == nil) {
            coordinator.generation = generation
            let selection = view.selectedRange
            view.text = text
            view.selectedRange = NSRange(location: min(reset ? initialSelection.location : selection.location, (text as NSString).length), length: 0)
            if reset { view.undoManager?.removeAllActions(); view.setContentOffset(.zero, animated: false) }
        }
        let accessibilityLabel = sourceMode ? "Screenplay Fountain text" : "Screenplay page text"
        if view.accessibilityLabel != accessibilityLabel { view.accessibilityLabel = accessibilityLabel }
        coordinator.style(); coordinator.updateAccessory()
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: NativePageEditor
        weak var view: ScreenplayTextView?
        var generation: UUID?
        var lastCommand: UUID?
        private var styling = false
        private var automaticReturn = false
        private var pendingElement: ScreenplayElement?
        private var cachedSource = "\0"
        private var cachedLines: [ScreenplayLine] = []
        private var styledSource = "\0"
        private var styledWidth: CGFloat = -1
        private var styledMode = false
        private var accessoryElement: ScreenplayElement?
        private var reportedSelection: NSRange?
        private var reportedGeneration: UUID?
        private var elementButton: UIBarButtonItem!
        private var undoButton: UIBarButtonItem!
        private var redoButton: UIBarButtonItem!
        init(_ parent: NativePageEditor) { self.parent = parent }

        func configureAccessory() {
            guard let view else { return }
            let toolbar = UIToolbar(frame: CGRect(x: 0, y: 0, width: 390, height: 44))
            toolbar.autoresizingMask = [.flexibleWidth]
            toolbar.tintColor = view.tintColor
            elementButton = UIBarButtonItem(title: "Action", style: .plain, target: nil, action: nil)
            elementButton.accessibilityLabel = "Screenplay element"; elementButton.accessibilityIdentifier = "screenplay-element-menu"
            undoButton = UIBarButtonItem(image: UIImage(systemName: "arrow.uturn.backward"), style: .plain, target: self, action: #selector(undo))
            undoButton.accessibilityLabel = "Undo writing"
            redoButton = UIBarButtonItem(image: UIImage(systemName: "arrow.uturn.forward"), style: .plain, target: self, action: #selector(redo))
            redoButton.accessibilityLabel = "Redo writing"
            let done = UIBarButtonItem(image: UIImage(systemName: "keyboard.chevron.compact.down"), style: .done, target: self, action: #selector(done))
            done.accessibilityLabel = "Hide keyboard"
            toolbar.items = [elementButton, .flexibleSpace(), undoButton, redoButton, .flexibleSpace(), done]
            view.inputAccessoryView = toolbar; updateAccessory()
        }
        private func label(_ kind: ScreenplayElement) -> String {
            switch kind { case .scene: return "Scene"; case .action: return "Action"; case .character: return "Character"; case .dialogue: return "Dialogue"; case .parenthetical: return "Parenthetical"; case .transition: return "Transition"; case .title: return "Title"; case .note: return "Note" }
        }
        private func currentLine() -> ScreenplayLine? {
            guard let view else { return nil }
            let position = min(view.selectedRange.location, (view.text as NSString).length)
            return visibleLines().last { $0.sourceRange.location <= position }
        }
        // Classify in full-document context, including dialogue continued across
        // a page boundary. Only intersecting source spans are styled in this view.
        private func visibleLines() -> [ScreenplayLine] {
            guard let view else { return [] }
            let source = parent.sourceBefore + view.text + parent.sourceAfter
            if source != cachedSource {
                cachedSource = source
                cachedLines = ScreenplayPagination.lines(in: source)
            }
            let start = parent.sourceBefore.utf16.count
            let end = start + view.text.utf16.count
            return cachedLines.compactMap { line in
                guard line.sourceRange.location <= end, NSMaxRange(line.sourceRange) >= start,
                      NSMaxRange(line.sourceRange) > start || line.sourceRange.length == 0 else { return nil }
                let lower = max(start, line.sourceRange.location)
                let upper = min(end, NSMaxRange(line.sourceRange))
                let contentStart = min(upper, max(lower, line.contentRange.location))
                let contentEnd = max(contentStart, min(upper, NSMaxRange(line.contentRange)))
                return .init(sourceRange: NSRange(location: lower - start, length: upper - lower),
                             contentRange: NSRange(location: contentStart - start, length: contentEnd - contentStart), element: line.element)
            }
        }
        private func currentElement() -> ScreenplayElement {
            guard let view else { return .action }
            if let line = currentLine() {
                let value = (view.text as NSString).substring(with: line.contentRange).trimmingCharacters(in: .whitespacesAndNewlines)
                if value.isEmpty, let pendingElement { return pendingElement }
                return line.element
            }
            return pendingElement ?? .action
        }
        func updateAccessory() {
            guard let view, elementButton != nil else { return }
            let kind = currentElement()
            // Replacing a live keyboard menu on every SwiftUI update invalidates
            // the keyboard layout again. Update UIKit only when values change.
            if accessoryElement != kind {
                accessoryElement = kind
                elementButton.title = label(kind) + " ▾"
                elementButton.menu = UIMenu(children: [ScreenplayElement.scene, .action, .character, .parenthetical, .transition].map { type in
                    UIAction(title: label(type), state: kind == type ? .on : .off) { [weak self] _ in self?.changeElement(type) }
                })
                let capitalization: UITextAutocapitalizationType = [.scene, .character, .transition].contains(kind) ? .allCharacters : .sentences
                if view.autocapitalizationType != capitalization { view.autocapitalizationType = capitalization }
            }
            let canUndo = view.undoManager?.canUndo == true, canRedo = view.undoManager?.canRedo == true
            if undoButton.isEnabled != canUndo { undoButton.isEnabled = canUndo }
            if redoButton.isEnabled != canRedo { redoButton.isEnabled = canRedo }
        }
        @objc private func done() { view?.resignFirstResponder() }
        @objc private func undo() { view?.undoManager?.undo(); updateAccessory() }
        @objc private func redo() { view?.undoManager?.redo(); updateAccessory() }
        func cycleElement() {
            let kinds: [ScreenplayElement] = [.action, .character, .parenthetical, .scene, .transition]
            changeElement(kinds[((kinds.firstIndex(of: currentElement()) ?? -1) + 1) % kinds.count])
        }
        func changeElement(_ kind: ScreenplayElement) {
            guard let view, view.markedTextRange == nil else { return }
            let source = view.text as NSString
            let position = min(view.selectedRange.location, source.length)
            let paragraph = source.paragraphRange(for: NSRange(location: position, length: 0))
            let original = source.substring(with: paragraph)
            let newline = original.hasSuffix("\r\n") ? "\r\n" : original.hasSuffix("\n") ? "\n" : original.hasSuffix("\r") ? "\r" : ""
            let line = currentLine()
            var value = line.map { source.substring(with: $0.contentRange) } ?? original
            value = value.trimmingCharacters(in: .whitespacesAndNewlines)
            if value.hasPrefix("("), value.hasSuffix(")") { value = String(value.dropFirst().dropLast()) }
            let replacement: String
            switch kind {
            case .scene: replacement = value.isEmpty ? "INT. " : (value.range(of: "^(INT|EXT|EST|I/E)", options: [.regularExpression, .caseInsensitive]) != nil ? value : "." + value)
            case .action: replacement = "!" + value
            case .character: replacement = "@" + value.uppercased()
            case .parenthetical: replacement = "(" + value + ")"
            case .transition: replacement = "> " + value.uppercased()
            default: return
            }
            guard source.length - paragraph.length + replacement.utf16.count + newline.utf16.count <= parent.maximumLength else { return }
            view.selectedRange = paragraph; pendingElement = kind
            view.insertText(replacement + newline)
            view.selectedRange = NSRange(location: paragraph.location + replacement.utf16.count - (kind == .parenthetical ? 1 : 0), length: 0)
            style(); updateAccessory(); view.becomeFirstResponder(); view.scrollRangeToVisible(view.selectedRange)
        }
        func textViewDidBeginEditing(_ textView: UITextView) {
            let origin = generation ?? parent.generation, selection = textView.selectedRange
            DispatchQueue.main.async { [weak self] in self?.parent.onFocus(true, origin, selection) }
            updateAccessory()
        }
        func textViewDidEndEditing(_ textView: UITextView) {
            let selection = textView.selectedRange, origin = generation ?? parent.generation
            DispatchQueue.main.async { [weak self] in self?.parent.onSelection(selection, origin); self?.parent.onFocus(false, origin, selection) }
        }
        func textViewDidChangeSelection(_ textView: UITextView) {
            guard !styling else { return }
            updateAccessory()
            let selected = textView.selectedRange, origin = generation ?? parent.generation
            guard selected != reportedSelection || origin != reportedGeneration else { return }
            reportedSelection = selected; reportedGeneration = origin
            DispatchQueue.main.async { [weak self] in self?.parent.onSelection(selected, origin) }
        }
        func textViewDidChange(_ textView: UITextView) {
            guard !styling else { return }
            if parent.text != textView.text { parent.text = textView.text }
            if textView.markedTextRange == nil { style() }
            updateAccessory()
            textView.scrollRangeToVisible(textView.selectedRange)
        }
        func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
            let source = textView.text as NSString
            guard !text.contains("\0"), range.location <= source.length, NSMaxRange(range) <= source.length,
                  source.length - range.length + text.utf16.count <= parent.maximumLength else { return false }
            guard !parent.sourceMode, !automaticReturn, text == "\n", range.length == 0,
                  textView.markedTextRange == nil else { return true }
            // Only continue an element at the end of its source line. Enter in
            // a sentence retains normal editing semantics.
            let paragraph = source.paragraphRange(for: range)
            let suffix = source.substring(with: NSRange(location: range.location, length: NSMaxRange(paragraph) - range.location)).trimmingCharacters(in: .newlines)
            guard suffix.isEmpty else { return true }
            let kind = currentElement()
            let inserted: String
            switch kind {
            case .character, .parenthetical: inserted = "\n"; pendingElement = .dialogue
            case .dialogue: inserted = "\n\n@"; pendingElement = .character
            case .scene, .transition: inserted = "\n\n!"; pendingElement = .action
            case .action: inserted = "\n\n!"; pendingElement = .action
            default: return true
            }
            guard source.length + inserted.utf16.count <= parent.maximumLength else { return false }
            automaticReturn = true; textView.insertText(inserted); automaticReturn = false
            return false
        }

        func style() {
            guard let view, !styling, view.markedTextRange == nil else { return }
            let fullSource = parent.sourceBefore + view.text + parent.sourceAfter
            let styleKey = "\(parent.sourceBefore.utf16.count):\(view.text.utf16.count):" + fullSource
            guard styledSource != styleKey || styledWidth != view.bounds.width || styledMode != parent.sourceMode else { return }
            styledSource = styleKey; styledWidth = view.bounds.width; styledMode = parent.sourceMode
            styling = true; defer { styling = false }
            let selection = view.selectedRange, offset = view.contentOffset
            let size: CGFloat = parent.sourceMode ? 15 : 16
            let font = UIFontMetrics(forTextStyle: .body).scaledFont(for: UIFont(name: "Courier", size: size) ?? .monospacedSystemFont(ofSize: size, weight: .regular), maximumPointSize: 26)
            let ink = parent.sourceMode ? UIColor.label : UIColor(red: 0.13, green: 0.12, blue: 0.10, alpha: 1)
            view.textContainerInset = UIEdgeInsets(top: 22, left: parent.sourceMode ? 14 : 20, bottom: 40, right: parent.sourceMode ? 14 : 18)
            let width = max(220, view.bounds.width - view.textContainerInset.left - view.textContainerInset.right)
            view.undoManager?.disableUndoRegistration()
            view.textStorage.beginEditing()
            view.textStorage.setAttributes([.font: font, .foregroundColor: ink], range: NSRange(location: 0, length: view.textStorage.length))
            if !parent.sourceMode {
                for line in visibleLines() {
                    guard NSMaxRange(line.sourceRange) <= view.textStorage.length else { continue }
                    let kind = line.element
                    let paragraph = NSMutableParagraphStyle(); paragraph.lineSpacing = 2
                    switch kind {
                    case .character: paragraph.headIndent = width * 0.40; paragraph.firstLineHeadIndent = width * 0.40
                    case .dialogue: paragraph.headIndent = width * 0.16; paragraph.firstLineHeadIndent = width * 0.16; paragraph.tailIndent = -width * 0.10
                    case .parenthetical: paragraph.headIndent = width * 0.24; paragraph.firstLineHeadIndent = width * 0.24; paragraph.tailIndent = -width * 0.15
                    case .transition: paragraph.alignment = .right
                    case .title: paragraph.alignment = .center
                    default: break
                    }
                    var attributes: [NSAttributedString.Key: Any] = [.paragraphStyle: paragraph]
                    if kind == .scene || kind == .title { attributes[.font] = UIFont(name: "Courier-Bold", size: font.pointSize) ?? .monospacedSystemFont(ofSize: font.pointSize, weight: .bold) }
                    if kind == .note { attributes[.foregroundColor] = UIColor.gray }
                    view.textStorage.addAttributes(attributes, range: line.sourceRange)
                    // Presentation only: hide Fountain's forcing prefix. The
                    // underlying string/ranges remain lossless and editable.
                    let prefix = NSRange(location: line.sourceRange.location, length: max(0, line.contentRange.location - line.sourceRange.location))
                    // Retain line height for an empty forced cue: a near-zero
                    // prefix font would also shrink the insertion caret to a dot.
                    if prefix.length > 0 { view.textStorage.addAttribute(.foregroundColor, value: UIColor.clear, range: prefix) }
                }
            }
            view.textStorage.endEditing(); view.undoManager?.enableUndoRegistration()
            view.selectedRange = selection
            view.typingAttributes = [.font: font, .foregroundColor: ink]
            if !parent.sourceMode, view.textStorage.length > 0 {
                let location = min(selection.location, view.textStorage.length - 1)
                view.typingAttributes[.paragraphStyle] = view.textStorage.attribute(.paragraphStyle, at: location, effectiveRange: nil)
            }
            view.setContentOffset(offset, animated: false)
        }
    }
}

private final class ScreenplayTextView: UITextView {
    var onWidthChange: (() -> Void)?
    var onTab: (() -> Void)?
    private var previousWidth: CGFloat = 0
    override func layoutSubviews() {
        super.layoutSubviews()
        if abs(bounds.width - previousWidth) > 1 { previousWidth = bounds.width; onWidthChange?() }
    }
    override var keyCommands: [UIKeyCommand]? {
        [UIKeyCommand(input: "\t", modifierFlags: [], action: #selector(nextElement))]
    }
    @objc private func nextElement() { onTab?() }
}
