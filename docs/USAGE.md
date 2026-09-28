# Using QiScreenwrite

## Writing and saving

Create a draft in **My drafts**, or import your own Fountain/text/common FDX file. Use **Page** for screenplay elements and **Fountain** for direct markup. Scene navigation, title-page fields, find/replace and preview are available in the desktop writing workspace.

Desktop **Save** and **Command/Ctrl-S** create explicit revisions. **Develop** and **World Builder** share a development record that also needs saving. Working-copy recovery is separate from saved history. If recovery is offered, review it before discarding it.

The iPhone app saves its working copy automatically. **Save revision** creates a deliberate checkpoint containing the screenplay and development/world content. Use **Hide keyboard** to restore the navigation and workspace controls.

On iPhone, Page boundaries remain stable while typing. They are recalculated when you hide the keyboard or navigate. Tap the page count to jump. **Fountain** displays the complete source. Undo is scoped to the current source window; navigating to another page starts a new undo context. The app supports a draft of up to 200,000 UTF-16 units.

## Develop the story and its world

Use **Develop** for a concept, logline, synopsis, outline, beats, characters and attributed research notes. World Builder adds places, characters, rules, groups, timeline notes, themes, props and relationships.

Link elements to one another or to identified screenplay scenes and character cues. Missing or changed targets need review; repeated scene headings should have unique scene numbers. An element or relationship records your creative choice, not a verified fact inferred by the software.

On desktop, **Shared library** can publish a local world snapshot and bring it into another draft. Linked imports track a particular library revision and review later changes. Independent imports stay independent. Publishing to this library means saving within your local workspace, not publishing on the internet.

## History, export and backup

Use **History** to compare saved revisions. Restore an earlier revision into the editor and save a new one; history is not rewritten.

Desktop export includes Fountain, common Final Draft XML, PDF, DOCX and reports. Check the result in the receiving application. FDX support does not preserve every proprietary field or layout feature.

Use **Back up** for saved workspace history. Save your work first: desktop backups exclude unsaved recovery and connector credentials. Keep multiple independent copies. The desktop CLI can restore into a new, nonexistent directory; read [backup and recovery](../local/server/BACKUP-RECOVERY.md) before doing so. Preservation packages add inventories and checksums; checksums identify bytes, not ownership or a successfully exercised restore.

Do not commit your private workspace, backups, `.qilocal` files, `.qiscript` files or real scripts to GitHub.

## Continue on iPhone or Mac

Export a **project copy** (`.qiscript`) and transfer it using Files, AirDrop or another method you choose. On the receiving device, review and import it. This creates an independent local copy and retains the source device’s original.

Current screenplay content, development and world elements travel together. Saved histories, rights ledgers, source originals, publication lineage, credentials and hosted service receipts are not a full-library transfer. Read the [exchange contract](../iphone/CONTRACT.md) for precise fields and limits. Live synchronization is not enabled.

## Optional creative analysis

Local models require your own Ollama installation, a running model and an explicitly selected endpoint. Review the exact text or opening excerpt before sending it to that machine. No model is bundled, and the app does not download one automatically.

Reports are advisory. Keep their source revision and model information when using them as research. Running your own model uses your own machine/resources; it does not spend platform credits. Hosted scoring and paid services require the separate configured service described in [the connection plan](CANISCREENWRITE-CONNECTION.md).

## Collaborators and rights

Desktop **Rights** records people, contributions, credits, proposed splits and evidence references. Unknown percentages remain unknown. A locally saved worksheet or review note is not another person’s authenticated signature, a legal determination or rights clearance.

Future token preparation can draft metadata tied to a saved source and rights record. Review public fields before exporting. There is no built-in wallet, blockchain transaction, NFT minting or royalty collection in this source release.

## When something goes wrong

- Keep your original imported file and current exports.
- If saving fails, preserve the open editor and export your working copy before restarting.
- If the app reports a damaged file, retain it and restore into a separate workspace instead of overwriting your only copy.
- If a connector reports a conflict, reload and review both versions. Do not treat a failed transfer as permission to overwrite the remote work.
- For a bug report, use a short synthetic example and identify the commit/build, operating system and steps. Never attach private creative work or credentials to a public issue.
