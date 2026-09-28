import XCTest

/// Run through scripts/prepare-page-ui-tests.py. It creates an isolated simulator
/// app identifier and temporary project, preserving the normal app and library.
final class PageWritingUITests: XCTestCase {
    func testElementContinuationWithSoftwareKeyboard() {
        continueAfterFailure = false
        let app = XCUIApplication(); app.launch()
        XCTAssertTrue(app.buttons["new-draft"].waitForExistence(timeout: 15))
        app.buttons["new-draft"].tap()
        let editor = app.textViews["screenplay-editor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 10))
        editor.tap()
        app.buttons["Screenplay element"].tap()
        let menuAttachment = XCTAttachment(screenshot: app.screenshot())
        menuAttachment.name = "element-menu"; menuAttachment.lifetime = .keepAlways; add(menuAttachment)
        app.buttons["Scene"].tap()
        XCTAssertEqual(editor.value as? String, "INT. ")
        editor.typeText("ROOM - DAY\nRain falls.\n")
        XCTAssertEqual(editor.value as? String, "INT. ROOM - DAY\n\n!Rain falls.\n\n!")
        app.buttons["Screenplay element"].tap()
        app.buttons["Character"].tap()
        editor.typeText("MAYA\nListen.\n")
        XCTAssertEqual(editor.value as? String, "INT. ROOM - DAY\n\n!Rain falls.\n\n@MAYA\nListen.\n\n@")
        XCTAssertTrue(app.keyboards.firstMatch.exists, "Verify the full on-screen keyboard, not only the accessory")
        XCTAssertGreaterThan(editor.frame.height, 150)
        XCTAssertLessThanOrEqual(editor.frame.maxY, app.keyboards.firstMatch.frame.minY + 1)
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = "04-software-keyboard-continuation"; attachment.lifetime = .keepAlways
        add(attachment)
        app.buttons["Hide keyboard"].tap()
        XCTAssertTrue(app.buttons["workspace-tools"].isHittable)
    }

    func testPageEditingKeyboardAndSourcePreservation() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launch()
        let newDraft = app.buttons["new-draft"]
        XCTAssertTrue(newDraft.waitForExistence(timeout: 15))
        newDraft.tap()
        let editor = app.textViews["screenplay-editor"]
        XCTAssertTrue(editor.waitForExistence(timeout: 10))
        func mode(_ name: String) {
            app.buttons["writing-view-mode"].tap()
            app.buttons[name].tap()
        }
        func hideKeyboard() {
            let hide = app.buttons["Hide keyboard"]
            if hide.waitForExistence(timeout: 3) { hide.tap() }
        }
        func capture(_ name: String) {
            let attachment = XCTAttachment(screenshot: app.screenshot())
            attachment.name = name; attachment.lifetime = .keepAlways
            add(attachment)
        }
        mode("Fountain")
        let first = "INT. OBSERVATORY - NIGHT\n\n!Rain taps the glass.\n\n@MAYA\n(quietly)\nThe sky is listening.\n\n===\n"
        let second = "EXT. ROOFTOP - NIGHT\n\n!A paper map unfolds in the wind.\n\n===\n"
        let third = "INT. STAIRWELL - DAWN\n\n!The final door opens.\n"
        let source = first + second + third
        editor.tap(); editor.typeText(source)
        XCTAssertEqual(editor.value as? String, source)
        hideKeyboard(); mode("Pages")
        app.buttons["page-picker"].tap()
        app.buttons["Go to page 1"].tap()
        XCTAssertEqual(editor.value as? String, first)
        XCTAssertEqual(app.buttons["page-picker"].label, "Page 1 of 3")
        capture("01-formatted-page")
        app.buttons["Next page"].tap()
        XCTAssertEqual(editor.value as? String, second)
        editor.tap(); editor.typeText("QA_EDIT")
        XCTAssertTrue(app.buttons["Hide keyboard"].exists)
        XCTAssertFalse(app.buttons["workspace-tools"].isHittable)
        XCTAssertFalse(app.tabBars.firstMatch.isHittable)
        XCTAssertTrue(app.buttons["Screenplay element"].exists)
        capture("02-keyboard-writing")
        let edited = editor.value as! String
        XCTAssertTrue(edited.contains("QA_EDIT"))
        app.buttons["Undo writing"].tap()
        XCTAssertEqual(editor.value as? String, second)
        app.buttons["Redo writing"].tap()
        XCTAssertEqual(editor.value as? String, edited)
        // Navigate while focused: queued focus callbacks must not jump pages.
        app.buttons["Next page"].tap()
        XCTAssertEqual(editor.value as? String, third)
        XCTAssertEqual(app.buttons["page-picker"].label, "Page 3 of 3")
        mode("Fountain")
        XCTAssertEqual(editor.value as? String, first + edited + third)
        mode("Pages")
        app.buttons["page-picker"].tap()
        app.buttons["Go to page 1"].tap()
        XCTAssertEqual(editor.value as? String, first)
        capture("03-page-navigation")
        app.terminate(); app.launch()
        let drafts = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'draft-'"))
        XCTAssertTrue(drafts.firstMatch.waitForExistence(timeout: 10))
        drafts.firstMatch.tap()
        mode("Fountain")
        XCTAssertEqual(editor.value as? String, first + edited + third)
    }
}
