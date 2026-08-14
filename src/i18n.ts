/**
 * Tiny i18n layer. Strings live in a per-language dictionary; t() looks up the
 * active language and falls back to English for any missing key. The active
 * language is resolved once at load (and on a settings change) from either an
 * explicit override or Obsidian's own UI language.
 */

import { getLanguage } from "obsidian";

export type Lang = "en" | "ko";
/** Settings value: "auto" follows Obsidian; "en"/"ko" force a language. */
export type LangSetting = "auto" | "en" | "ko";

/** Read Obsidian's UI language via the official getLanguage() API (guaranteed by
 *  our minAppVersion 1.8.7). Korean when it starts with "ko", else English. */
function detectObsidianLang(): Lang {
	return getLanguage().toLowerCase().startsWith("ko") ? "ko" : "en";
}

export function resolveLang(setting: LangSetting): Lang {
	if (setting === "ko" || setting === "en") return setting;
	return detectObsidianLang();
}

let current: Lang = "en";

/** Set the active language from a settings value. Call at load and on change. */
export function setLang(setting: LangSetting): void {
	current = resolveLang(setting);
}

export function getLang(): Lang {
	return current;
}

/** Look up a string, fill {placeholders}, fall back to English then the key. */
export function t(key: string, vars?: Record<string, string | number>): string {
	let s = STRINGS[current][key] ?? STRINGS.en[key] ?? key;
	if (vars) {
		for (const [k, v] of Object.entries(vars)) {
			s = s.split(`{${k}}`).join(String(v));
		}
	}
	return s;
}

const EN: Record<string, string> = {
	// commands
	"cmd.openTree": "Open tree view",
	"cmd.newNote": "New note (under active note's location)",
	"cmd.cascade": "Move location and descendants",
	"cmd.cascadeUndo": "Undo last location-tag rename",
	"cmd.namespaceUndo": "Undo last namespace change",
	"cmd.bootstrapPreview": "Import existing filenames (preview)",
	"cmd.bootstrapUndo": "Undo last bootstrap",
	"cmd.sepUndo": "Undo last separator change",
	"cmd.checkDuplicates": "Check for duplicate location tags",
	"cmd.dedupUndo": "Undo last duplicate-tag cleanup",
	// view / ribbon
	"view.treeName": "Trellis tree",
	// notices
	"notice.treeOff": "tree view is off (enable it in settings)",
	"notice.renamed": "{from} → {to}",
	"notice.renameFailed": "rename failed for {name}",
	"notice.renameCollision": "skipped {name}: target \"{target}\" already exists",
	"notice.filenameNotPortable":
		'skipped "{name}": the filename is not portable across supported devices',
	"notice.noTagkey": "could not derive a filename code (check the location tag)",
	"notice.exists": '"{base}" already exists',
	"notice.createFailed": 'failed to create "{base}"',
	"notice.retagged": "retagged {n} file(s) {from} → {to}",
	"notice.noFilesTagged": "no files tagged {from}",
	"notice.cascadeBadPath": "enter valid tag paths without spaces or reserved symbols",
	"notice.cascadeOutside": "cascade is limited to children of managed tag-key namespaces: {ns}",
	"notice.cascadeDifferentKey":
		"a cascade must stay in one tag-key namespace ({from} → {to} is not allowed)",
	"notice.noCascade": "no location-tag rename to undo",
	"notice.cascadeUndone": "restored the previous tags and filenames on {n} note(s)",
	"notice.noNamespaceChange": "no namespace change to undo",
	"notice.namespaceUndone": "restored the previous namespace on {n} note(s)",
	"notice.namespaceUndoStale":
		"the schema changed after this namespace migration; restore that schema before undoing",
	"notice.bulkBusy": "finish the current Trellis change first: {active}",
	"operation.automation": "automation apply",
	"notice.bootstrapped":
		'bootstrapped {n} file(s). Undo via "Undo last bootstrap".',
	"notice.bootstrapProgress": "bootstrapping… {done}/{total}",
	"notice.bootstrappedWithErrors":
		'bootstrapped {n} file(s) · {failed} skipped (errors). Undo via "Undo last bootstrap".',
	"notice.sepProgress": "changing separator… {done}/{total}",
	"notice.noBootstrap": "no bootstrap to undo",
	"notice.undid": "undid bootstrap on {n} file(s)",
	"notice.fillBoth": "fill in both fields",
	"notice.parentRequired": "parent is required",
	"notice.segmentRequired": "segment is required",
	"notice.segmentBadChar":
		"segment contains characters a tag can't hold (spaces, '/', or symbols like , [ ] # \" ')",
	"notice.parentBadChar":
		"parent contains characters a tag can't hold (spaces or symbols like , [ ] # \" ')",
	"notice.nsEmpty": "namespace cannot be empty",
	"notice.nsBadChar":
		"namespace can only contain letters, digits, '-' and '_' (no '/', spaces, or symbols)",
	"notice.nsApplied": "namespace set to '{ns}'",
	"setting.apply": "Apply",
	"setting.section.general": "General",
	"setting.section.scheme": "Filename",
	"setting.section.tree": "Sidebar tree view",
	"setting.formatPreview": "Preview: {name}",
	"setting.formatApplyName": "Apply filename formatting",
	"setting.formatApplyDesc":
		"Reviews all affected filenames before committing the three formatting options above.",
	"notice.sepEmpty": "separator cannot be empty",
	"notice.sepBadChar":
		"separator cannot contain letters, digits, '/', or filename-illegal characters (\\ : * ? \" < > |)",
	"notice.sepChanged": "separator {from} → {to} on {n} file(s)",
	"notice.sepReverted": "reverted separator change on {n} file(s)",
	"notice.noSepChange": "no separator change to undo",
	"notice.multiLocation":
		"{name} has {n} location tags — using the first (one note = one location)",
	"notice.noDuplicates": "no duplicate location tags found",
	"notice.deduped": "cleaned up duplicate tags on {n} file(s)",
	"notice.noDedup": "no duplicate-tag cleanup to undo",
	"notice.dedupUndone": "restored tags on {n} file(s)",
	"dedup.title": "Resolve duplicate location tags",
	"dedup.desc":
		"These notes carry more than one location tag. Pick the one to keep — the rest are removed from frontmatter (undoable).",
	"dedup.count": "{n} note(s) with duplicate location tags",
	"dedup.more":
		"Showing the first {shown}. {rest} more — apply, then run the check again.",
	"dedup.apply": "Apply",
	"dedup.defer": "Defer",
	// menu
	"menu.newHere": "New note here",
	// cascade modal
	"modal.cascade.title": "Move location and descendants",
	"modal.cascade.desc":
		"Moves this location and everything under it. Filename codes follow automatically.",
	"modal.namespaceBlocked.title": "Namespace is still in use",
	"modal.namespaceBlocked.desc":
		"This schema would stop managing these namespaces: {items}. Migrate or remove those tags first; nothing was changed.",
	"modal.cascade.fromName": "From",
	"modal.cascade.fromDesc": "Existing tag — type to search, ↑↓ + Enter to pick",
	"modal.cascade.toName": "To",
	"modal.cascade.toDesc": "New tag path (free text)",
	"modal.cascade.submit": "Rename",
	"modal.cascadePreview.title": "Review location-tag rename",
	"modal.cascadePreview.desc":
		"{n} note(s) will change from {from} to {to}. Any failure or cancellation rolls the completed part back.",
	"modal.cascadePreview.showList": "Show affected notes ({n})",
	"modal.cascadePreview.apply": "Rename — {n} note(s)",
	// new-note modal
	"modal.newNote.title": "New note",
	"modal.newNote.desc":
		"Create a note under a location tag. The parent is prefilled from the active note (editable, autocompleted). You assign the segment yourself; when the slot has an ID scheme, a suggestion is prefilled — always editable.",
	"modal.newNote.parentName": "Parent",
	"modal.newNote.parentDesc":
		"Existing location tag to create under — type to search, ↑↓ + Enter",
	"modal.newNote.segmentName": "Segment",
	"modal.newNote.segmentDesc":
		"The identifier you assign for this level — e.g. a number 02, or a key C for a new sub-level",
	"modal.newNote.titleName": "Title",
	"modal.newNote.submit": "Create",
	"ph.segment": "e.g. 02 or C",
	"ph.noteTitle": "note title",
	// bootstrap modal
	"modal.bootstrap.title": "Bootstrap — dry-run preview",
	"modal.bootstrap.summary":
		"{assign} file(s) would get a tag · {already} already tagged (skipped) · {none} have no recognizable filename code (skipped). Nothing is written.",
	"modal.bootstrap.segmentWarning":
		"A visible hierarchy separator is active. Bootstrap treats every occurrence inside the tagkey as a level boundary; review names whose original segment may have contained that symbol.",
	"modal.bootstrap.willAssign": "Will assign ({n})",
	"modal.bootstrap.noTagkey": "No recognizable filename code — skipped ({n})",
	"modal.bootstrap.apply": "Apply — tag {n} file(s)",
	"modal.bootstrap.close": "Close",
	// bootstrap errors modal
	"modal.bootstrapErrors.title": "Bootstrap — skipped files",
	"modal.bootstrapErrors.desc":
		"{n} file(s) couldn't be tagged due to a frontmatter parse error (e.g. duplicate YAML keys). Fix these by hand, then re-run bootstrap:",
	// separator-change modal
	"modal.sep.title": "Change separator",
	"modal.sep.desc":
		"Filename formatting {from} → {to}. Only location-tagged files are included; free titles are preserved.",
	"modal.sep.count": "{n} file(s) will be renamed.",
	"modal.sep.none": "No files need renaming — the change applies to the setting only.",
	"modal.sep.showList": "Show affected files",
	"modal.sep.apply": "Change — {n} file(s)",
	"modal.sep.cancel": "Cancel",
	// settings
	"setting.nsName": "Location tag",
	"setting.nsDesc":
		"The tag family Trellis treats as the source of truth. For example, 'trel' manages #trel/S88/B07.",
	"setting.sepName": "Code–title symbol",
	"setting.sepDesc":
		"Symbol between the generated filename code and your title.",
	"setting.sepCustom": "Custom…",
	"setting.sepSpacingName": "Spaces around the symbol",
	"setting.sepSpacingDesc": "Choose where spaces appear around the code–title symbol.",
	"spacing.none": "None (BP-title)",
	"spacing.before": "Before (BP -title)",
	"spacing.after": "After (BP- title)",
	"spacing.both": "Both (BP - title)",
	"setting.segmentSepName": "Hierarchy shown in the filename code",
	"setting.segmentSepDesc":
		"Show or hide the levels of a location tag inside the generated code. Hidden keeps S88B07.",
	"segmentSep.hidden": "Hidden (S88B07)",
	"setting.posName": "Filename code position",
	"setting.posDesc": "Place the generated code before or after your title.",
	"setting.posPrefix": "Prefix — start of filename (S88B07-title)",
	"setting.posSuffix": "Suffix — end of filename (title-S88B07)",
	"setting.treeName": "Sidebar tree view",
	"setting.treeDesc":
		"Show a collapsible tree of the location-tag hierarchy in the sidebar (ribbon icon + command).",
	"setting.treeTagKeyName": "Classic tree tag-key",
	"setting.treeTagKeyDesc":
		"Choose the single tag-key used by the notes-only tree. The nested tag tree still shows every tag-key.",
	"setting.treeLabelName": "Sidebar view name",
	"setting.treeLabelDesc":
		"Custom title for the tree view's tab. Leave blank for the default. Avoid reusing the core File explorer's name.",
	"setting.headerButtonsName": "Tree actions",
	"setting.headerButtonsDesc":
		"Choose which actions appear directly in the header or in its More menu.",
	"setting.hb.newNote": "New note",
	"setting.hb.sort": "Sort direction",
	"setting.hb.collapseAll": "Collapse / expand all",
	"setting.hb.showCurrent": "Show current file",
	"setting.hb.bootstrap": "Import existing filenames",
	"setting.hb.cascade": "Move location and descendants",
	"setting.hb.undo": "Undo",
	"setting.sortName": "Tree sort by",
	"setting.sortDesc":
		"Sort order in the tree (ascending/descending is toggled in the panel header).",
	"setting.sortTagkey": "Filename code",
	"setting.sortMtime": "Modified time",
	"setting.sortCtime": "Created time",
	"setting.langName": "Language",
	"setting.langDesc": "UI language. Auto follows Obsidian's language.",
	"setting.langAuto": "Auto",
	// tree view
	"tree.newNote": "New note",
	"tree.sortAsc": "Sort: ascending (click for descending)",
	"tree.sortDesc": "Sort: descending (click for ascending)",
	"tree.collapseAll": "Collapse / expand all",
	"tree.showCurrent": "Show current file",
	"tree.bootstrap": "Import existing filenames…",
	"tree.cascade": "Move location and descendants",
	"tree.undo": "Undo…",
	"tree.empty": "No location-tagged notes found.",
	// bootstrap select modal
	"modal.bootstrapSelect.title": "Bootstrap — select targets",
	"modal.bootstrapSelect.desc":
		'Pick folders or notes to bootstrap. Checking a folder selects every note under it; notes can be toggled individually, and folders + notes can be mixed. Use "Select all" for the whole vault. The next step previews before anything is written.',
	"modal.bootstrapSelect.selectAll": "Select all",
	"modal.bootstrapSelect.clear": "Clear",
	"modal.bootstrapSelect.next": "Next — preview ({n})",
	"modal.bootstrapSelect.untaggedOnly": "Show only untagged notes",
	"modal.bootstrapSelect.empty": "No notes to show.",
	"modal.bootstrapSelect.tagged": "✓ tagged",
	"ph.bootstrapSearch": "Search notes by name…",
	"notice.bootstrapNoSelection": "nothing selected",
	// bulk progress modal (0.2.0)
	"bulk.pause": "Pause",
	"bulk.resume": "Resume",
	"bulk.cancel": "Cancel",
	"bulk.elapsed": "{sec}s elapsed",
	"bulk.errors": "{n} error(s)",
	"bulk.slowHint":
		"Slow? Usually many targets or slow file I/O (e.g. a cloud-synced vault).",
	"bulk.title.bootstrap": "Applying bootstrap",
	"bulk.title.separator": "Changing separator",
	"bulk.title.namespace": "Changing namespace",
	"bulk.title.namespaceUndo": "Undoing namespace change",
	"bulk.unexpectedFailure": "Unexpected migration failure",
	"bulk.progress": "{done} / {total}",
	"bulk.done": "Done",
	"bulk.rolledBack": "Rolled back",
	"bulk.cancelledLabel": "Cancelled",
	"bulk.ok": "OK",
	"bulk.summary": "{done} processed · {skipped} skipped",
	"bulk.skippedTitle": "Skipped notes ({n})",
	"bulk.skippedDesc":
		"Not applied because the note changed, its target name collided, or its frontmatter could not be read. Review these notes, then run it again.",
	"notice.bootstrapCancelled":
		'bootstrap cancelled — {n} file(s) already tagged (undo via "Undo last bootstrap")',
	"notice.sepCancelled":
		'separator change cancelled — {n} file(s) already renamed (undo via "Undo last separator change")',
	// advanced multi-key slot editor (0.2.0, experimental)
	"setting.advName": "Advanced — multi-key slots (experimental)",
	"setting.advDesc":
		"Edit the filename as an array of key slots. Each tag-key slot syncs from its own namespace; the name slot stays free. Applying shows an exact rename preview and runs as one undoable batch.",
	"setting.advSlots": "Slots",
	"adv.slot": "Slot {n}",
	"adv.roleTag": "Tag key",
	"adv.roleName": "Name key (free title)",
	"adv.nsPh": "namespace, e.g. trel",
	"adv.sep": "Separator {n} (between slot {a} and slot {b})",
	"adv.addTag": "Add tag-key slot",
	"adv.addName": "Add name-key slot",
	"adv.moveUp": "Move up",
	"adv.moveDown": "Move down",
	"adv.remove": "Remove slot",
	"adv.addSlot": "Add slot",
	"adv.pending": "Pending changes",
	"adv.apply": "Apply",
	"adv.revert": "Revert",
	"adv.invalidTitle": "Invalid schema",
	"adv.invalid.needTag": "At least one tag-key slot is required.",
	"adv.invalid.oneName": "Only one name-key slot is supported.",
	"adv.invalid.nsEmpty": "A tag slot namespace cannot be empty.",
	"adv.invalid.nsBad": "Namespace '{ns}' has illegal characters — use letters, digits, '-' or '_'.",
	"adv.invalid.nsDup": "Namespace '{ns}' is used by more than one tag slot.",
	"adv.invalid.sep": "Separator {n} is empty or contains an illegal character.",
	"adv.invalid.spacing": "Separator {n} has an invalid spacing mode.",
	"adv.invalid.conflict":
		"A tag hierarchy separator matches an adjacent boundary symbol with no spacing. Change one of them or add boundary spacing.",
	"notice.advApplied": "schema applied",
	"modal.ok": "OK",
	"modal.confirm.dontAsk": "Don't ask again",
	"modal.confirm.ok": "Apply",
	"modal.confirm.cancel": "Cancel",
	"modal.badSep.title": "Invalid separator",
	"modal.badSep.desc": "A separator cannot be empty and cannot contain letters, digits, spaces, or characters illegal in filenames. Try a symbol like -, _, . or ~.",
	"modal.badSep.conflict":
		"The tag hierarchy separator is identical to an adjacent slot-boundary symbol with no spaces, so the filename would be ambiguous. Change one symbol or add boundary spacing.",
	"modal.applySchema.title": "Apply schema changes?",
	"modal.applySchema.desc": "This updates the filename scheme. Existing files are re-synced as their tags change; nothing is renamed right now.",
	"setting.statsName": "Live vault status",
	"setting.statsDesc":
		"{managed} of {total} notes · {tags} managed tag value(s) · {paths} unique path(s). Updates while settings are open.",
	"setting.statsGeneralName": "Ordinary tags",
	"setting.statsGeneralDesc": "{tags} explicit use(s) · {unique} unique tag(s)",
	"setting.statsKeyName": "Slot {n} tag-key · #{ns}/…",
	"setting.statsKeyDesc":
		"{notes} note(s) · {tags} value(s) · {paths} unique path(s) · {duplicates} duplicate note(s) · {inline} inline-only note(s) · {roots} namespace-node note(s)",
	"setting.statsPaths": "Top paths ({n})",
	"setting.statsMore": "+ {n} more path(s)",
	"setting.statsRootUnknownName": "Unrecognized owner-root tags",
	"setting.statsRootUnknownDesc":
		"{n} explicit tag(s) are under the owner root but do not match any tag-key namespace.",
	"notice.advLastTag": "at least one tag-key slot is required",
	"notice.advOneName": "only one name-key slot is supported",
	"notice.advNsEmpty": "tag slot namespace cannot be empty",
	"notice.advNsDup": "tag slot namespaces must be distinct",
	"notice.advReset": "schema reset to single-key (tag + name)",
	"setting.experimentalName": "Experimental filename features",
	"setting.experimentalDesc":
		"Optional tools for vaults that need an owner root, automatic ID suggestions, or more than one managed key. Most vaults can leave this closed.",
	// root namespace (0.3.0 experimental, B25)
	"setting.rootName": "Root namespace (experimental)",
	"setting.rootDesc":
		"A single owner root every managed tag starts with (e.g. \"trellis\" → #trellis/tree/…). Leave empty for the classic rootless shape. Applying migrates every managed tag in the vault (undoable); filenames do not change.",
	"cmd.rootUndo": "Undo last root namespace change",
	"modal.root.title": "Change root namespace?",
	"modal.root.desc":
		"\"{from}\" → \"{to}\": rewrites the managed location tags on {n} note(s). Filenames stay the same — only the tag's owner layer moves. Undoable.",
	"notice.rootChanged": "root namespace \"{from}\" → \"{to}\" on {n} note(s)",
	"notice.rootUndone": "root namespace reverted on {n} note(s)",
	"notice.noRootChange": "no root namespace change to undo",
	"notice.rootBadChar":
		"root namespace can only contain letters, digits, '-' and '_' (no '/', spaces, or symbols)",
	"bulk.title.root": "Changing root namespace",
	"bulk.title.cascade": "Renaming location tags",
	"bulk.title.cascadeUndo": "Undoing location-tag rename",
	// ID scheme presets (0.3.0 experimental, B26)
	"setting.schemeName": "Automatic ID suggestion (experimental)",
	"setting.schemeDesc":
		"Optional preset for the primary tag slot. Suggests the next segment for new notes and sharpens bootstrap parsing. Live sync stays format-agnostic either way.",
	"scheme.none": "None (format-agnostic)",
	"scheme.spark": "Alternating letters/digits (S/88/B/07)",
	"scheme.zettel": "Zettelkasten timestamp (YYYYMMDDHHMMSS)",
	"scheme.date": "Date (YYYYMMDD)",
	"scheme.seq": "Sequence number (1, 2, 3…)",
	"adv.scheme": "ID scheme",
	// nested tag view (0.3.0 experimental, B24)
	"setting.treeModeName": "Tree view mode",
	"setting.treeModeDesc":
		"Notes: only real notes, segment layers transparent (classic). Tags: the full nested tag hierarchy, folder-style, like the core tag pane.",
	"setting.treeModeNotes": "Notes (classic)",
	"setting.treeModeTags": "Nested tags",
	"setting.showRootName": "Show namespace layers (nested mode)",
	"setting.showRootDesc":
		"Show the root/namespace tags (e.g. tree) as top rows, or start directly at your hierarchy.",
	"setting.untaggedName": "Show untagged notes (nested mode)",
	"setting.untaggedDesc":
		"List notes carrying no managed location tag in a section at the bottom, so onboarding misses stay visible.",
	"setting.labelModeName": "Row label (nested mode)",
	"setting.labelModeDesc":
		"What a note row shows: its filename, or only its tag segment.",
	"setting.labelModeFilename": "Filename",
	"setting.labelModeTag": "Tag segment only",
	"setting.hb.viewMode": "View mode toggle",
	"tree.modeToNotes": "Switch to notes view",
	"tree.modeToTags": "Switch to nested tag view",
	"tree.more": "More actions",
	"tree.undoCount": "{action} — {n} note(s)",
	"tree.untagged": "Untagged notes ({n})",
};

const KO: Record<string, string> = {
	// commands
	"cmd.openTree": "트리 뷰 열기",
	"cmd.newNote": "새 노트 (현재 노트 위치 아래)",
	"cmd.cascade": "하위 위치 함께 변경",
	"cmd.cascadeUndo": "마지막 위치 태그 이름 변경 되돌리기",
	"cmd.namespaceUndo": "마지막 네임스페이스 변경 되돌리기",
	"cmd.bootstrapPreview": "기존 파일명 편입 미리보기",
	"cmd.bootstrapUndo": "마지막 부트스트랩 되돌리기",
	"cmd.sepUndo": "마지막 구분자 변경 되돌리기",
	"cmd.checkDuplicates": "중복 위치 태그 점검",
	"cmd.dedupUndo": "마지막 중복 태그 정리 되돌리기",
	// view / ribbon
	"view.treeName": "Trellis 트리",
	// notices
	"notice.treeOff": "트리 뷰가 꺼져 있습니다 (설정에서 켜세요)",
	"notice.renamed": "{from} → {to}",
	"notice.renameFailed": "{name} 이름 변경 실패",
	"notice.renameCollision": "{name} 건너뜀: 대상 \"{target}\" 이(가) 이미 있습니다",
	"notice.filenameNotPortable":
		'"{name}" 건너뜀: 지원 기기 간에 호환되지 않는 파일명입니다',
	"notice.noTagkey": "파일명 코드를 읽을 수 없습니다 (위치 태그 확인)",
	"notice.exists": '"{base}" 이(가) 이미 있습니다',
	"notice.createFailed": '"{base}" 생성 실패',
	"notice.retagged": "{n}개 파일 재태그 {from} → {to}",
	"notice.noFilesTagged": "{from} 태그가 붙은 파일 없음",
	"notice.cascadeBadPath": "공백이나 예약 문자가 없는 올바른 태그 경로를 입력하세요",
	"notice.cascadeOutside": "하위 전체 변경은 관리 태그키 네임스페이스 안에서만 가능합니다: {ns}",
	"notice.cascadeDifferentKey":
		"하위 전체 변경은 하나의 태그키 안에서만 가능합니다 ({from} → {to} 이동 불가)",
	"notice.noCascade": "되돌릴 위치 태그 이름 변경이 없습니다",
	"notice.cascadeUndone": "{n}개 노트의 이전 태그와 파일명을 복원했습니다",
	"notice.noNamespaceChange": "되돌릴 네임스페이스 변경이 없습니다",
	"notice.namespaceUndone": "{n}개 노트를 이전 네임스페이스로 복원했습니다",
	"notice.namespaceUndoStale":
		"네임스페이스 변경 뒤 스키마가 달라졌습니다. 해당 스키마를 먼저 복원하세요",
	"notice.bulkBusy": "현재 Trellis 변경을 먼저 끝내세요: {active}",
	"operation.automation": "자동화 적용",
	"notice.bootstrapped":
		'{n}개 파일 부트스트랩 완료. "마지막 부트스트랩 되돌리기"로 취소.',
	"notice.bootstrapProgress": "부트스트랩 중… {done}/{total}",
	"notice.bootstrappedWithErrors":
		'{n}개 완료 · {failed}개 건너뜀(오류). "마지막 부트스트랩 되돌리기"로 취소.',
	"notice.sepProgress": "구분자 변경 중… {done}/{total}",
	"notice.noBootstrap": "되돌릴 부트스트랩 없음",
	"notice.undid": "{n}개 파일 부트스트랩 되돌림",
	"notice.fillBoth": "두 칸 모두 입력하세요",
	"notice.parentRequired": "부모가 필요합니다",
	"notice.segmentRequired": "세그먼트가 필요합니다",
	"notice.segmentBadChar":
		"세그먼트에 태그로 쓸 수 없는 문자가 있습니다 (공백·'/'·, [ ] # \" ' 같은 기호)",
	"notice.parentBadChar":
		"부모에 태그로 쓸 수 없는 문자가 있습니다 (공백·, [ ] # \" ' 같은 기호)",
	"notice.nsEmpty": "네임스페이스는 비울 수 없습니다",
	"notice.nsBadChar":
		"네임스페이스는 영문·숫자·'-'·'_'만 쓸 수 있습니다 ('/'·공백·기호 불가)",
	"notice.nsApplied": "네임스페이스를 '{ns}' 로 설정했습니다",
	"setting.apply": "적용",
	"setting.section.general": "일반",
	"setting.section.scheme": "파일명",
	"setting.section.tree": "사이드바 트리 뷰",
	"setting.formatPreview": "미리보기: {name}",
	"setting.formatApplyName": "파일명 형식 적용",
	"setting.formatApplyDesc":
		"위의 세 형식 옵션이 바꾸는 파일명을 검토한 뒤 한 번에 적용합니다.",
	"notice.sepEmpty": "구분자는 비울 수 없습니다",
	"notice.sepBadChar":
		"구분자에 영문·숫자·'/'·파일명 금지문자(\\ : * ? \" < > |)는 쓸 수 없습니다",
	"notice.sepChanged": "구분자 {from} → {to}, {n}개 파일 변경",
	"notice.sepReverted": "구분자 변경 {n}개 파일 되돌림",
	"notice.noSepChange": "되돌릴 구분자 변경 없음",
	"notice.multiLocation":
		"{name} 위치 태그 {n}개 — 첫 번째 사용 (노트 하나 = 위치 하나)",
	"notice.noDuplicates": "중복 위치 태그 없음",
	"notice.deduped": "{n}개 파일 중복 태그 정리됨",
	"notice.noDedup": "되돌릴 중복 태그 정리 없음",
	"notice.dedupUndone": "{n}개 파일 태그 복원됨",
	"dedup.title": "중복 위치 태그 정리",
	"dedup.desc":
		"아래 노트들은 위치 태그를 두 개 이상 갖고 있습니다. 남길 하나를 고르세요 — 나머지는 frontmatter에서 제거됩니다(되돌리기 가능).",
	"dedup.count": "중복 위치 태그 노트 {n}개",
	"dedup.more":
		"처음 {shown}개 표시. 외 {rest}개 — 적용 후 다시 점검하세요.",
	"dedup.apply": "적용",
	"dedup.defer": "보류",
	// menu
	"menu.newHere": "여기에 새 노트",
	// cascade modal
	"modal.cascade.title": "하위 위치 함께 변경",
	"modal.cascade.desc":
		"이 위치와 그 하위 전체를 옮깁니다. 파일명 코드는 자동으로 따라갑니다.",
	"modal.namespaceBlocked.title": "사용 중인 네임스페이스입니다",
	"modal.namespaceBlocked.desc":
		"이 스키마를 적용하면 다음 네임스페이스가 관리 밖으로 빠집니다: {items}. 먼저 해당 태그를 이관하거나 제거하세요. 변경된 내용은 없습니다.",
	"modal.cascade.fromName": "변경 전",
	"modal.cascade.fromDesc": "기존 태그 — 입력해 검색, ↑↓ + Enter로 선택",
	"modal.cascade.toName": "변경 후",
	"modal.cascade.toDesc": "새 태그 경로 (자유 입력)",
	"modal.cascade.submit": "이름 변경",
	"modal.cascadePreview.title": "위치 태그 이름 변경 검토",
	"modal.cascadePreview.desc":
		"{n}개 노트가 {from}에서 {to}(으)로 바뀝니다. 실패하거나 취소하면 완료된 부분을 되돌립니다.",
	"modal.cascadePreview.showList": "영향받는 노트 보기 ({n})",
	"modal.cascadePreview.apply": "이름 변경 — {n}개 노트",
	// new-note modal
	"modal.newNote.title": "새 노트",
	"modal.newNote.desc":
		"위치 태그 아래에 노트를 만듭니다. 부모는 현재 노트 기준으로 미리 채워집니다 (수정·자동완성 가능). 세그먼트는 직접 지정하되, 슬롯에 ID 스킴이 있으면 제안값이 미리 채워집니다 — 언제든 수정 가능합니다.",
	"modal.newNote.parentName": "부모",
	"modal.newNote.parentDesc": "아래에 만들 기존 위치 태그 — 입력해 검색, ↑↓ + Enter",
	"modal.newNote.segmentName": "세그먼트",
	"modal.newNote.segmentDesc":
		"이 단계에 부여할 식별자 — 예: 숫자 02, 또는 새 하위 단계용 키 C",
	"modal.newNote.titleName": "제목",
	"modal.newNote.submit": "만들기",
	"ph.segment": "예: 02 또는 C",
	"ph.noteTitle": "노트 제목",
	// bootstrap modal
	"modal.bootstrap.title": "부트스트랩 — 드라이런 미리보기",
	"modal.bootstrap.summary":
		"{assign}개 파일에 태그 부여 예정 · {already}개 이미 태그됨 (건너뜀) · {none}개 파일명 코드 인식 불가 (건너뜀). 아무것도 기록하지 않습니다.",
	"modal.bootstrap.segmentWarning":
		"표시형 계층 구분자가 켜져 있습니다. 부트스트랩은 태그키 안의 해당 기호를 모두 계층 경계로 해석하므로, 원래 세그먼트 자체에 그 기호가 있었을 수 있는 이름은 직접 검토하세요.",
	"modal.bootstrap.willAssign": "부여 예정 ({n})",
	"modal.bootstrap.noTagkey": "파일명 코드 인식 불가 — 건너뜀 ({n})",
	"modal.bootstrap.apply": "적용 — {n}개 파일 태그",
	"modal.bootstrap.close": "닫기",
	// bootstrap errors modal
	"modal.bootstrapErrors.title": "부트스트랩 — 건너뛴 파일",
	"modal.bootstrapErrors.desc":
		"{n}개 파일은 frontmatter 파싱 오류(예: 중복 YAML 키)로 태그를 못 붙였습니다. 직접 고친 뒤 부트스트랩을 다시 실행하세요:",
	// separator-change modal
	"modal.sep.title": "구분자 변경",
	"modal.sep.desc":
		"파일명 형식 {from} → {to}. 위치 태그가 붙은 파일만 대상으로 하며 자유 제목은 보존됩니다.",
	"modal.sep.count": "{n}개 파일의 이름이 바뀝니다.",
	"modal.sep.none": "이름이 바뀔 파일은 없습니다 — 설정값만 변경됩니다.",
	"modal.sep.showList": "바뀔 파일 보기",
	"modal.sep.apply": "변경 — {n}개 파일",
	"modal.sep.cancel": "취소",
	// settings
	"setting.nsName": "위치 태그",
	"setting.nsDesc":
		"Trellis가 원본으로 관리할 태그 계열입니다. 예를 들어 'trel'은 #trel/S88/B07을 관리합니다.",
	"setting.sepName": "코드와 제목 사이 기호",
	"setting.sepDesc":
		"자동 생성되는 파일명 코드와 사용자가 붙인 제목 사이의 기호입니다.",
	"setting.sepCustom": "사용자 지정…",
	"setting.sepSpacingName": "기호 주위 공백",
	"setting.sepSpacingDesc": "코드와 제목 사이 기호의 어느 쪽에 공백을 둘지 정합니다.",
	"spacing.none": "없음 (BP-제목)",
	"spacing.before": "왼쪽 (BP -제목)",
	"spacing.after": "오른쪽 (BP- 제목)",
	"spacing.both": "양쪽 (BP - 제목)",
	"setting.segmentSepName": "파일명 코드의 계층 표시",
	"setting.segmentSepDesc":
		"위치 태그의 각 계층을 자동 생성 코드에 표시할지 정합니다. 숨김은 S88B07 형식을 유지합니다.",
	"segmentSep.hidden": "숨김 (S88B07)",
	"setting.posName": "파일명 코드 위치",
	"setting.posDesc": "자동 생성 코드를 제목 앞이나 뒤에 둡니다.",
	"setting.posPrefix": "접두 — 파일명 앞 (S88B07-제목)",
	"setting.posSuffix": "접미 — 파일명 뒤 (제목-S88B07)",
	"setting.treeName": "사이드바 트리 뷰",
	"setting.treeDesc":
		"위치 태그 계층을 사이드바에 접을 수 있는 트리로 표시합니다 (리본 아이콘 + 명령).",
	"setting.treeTagKeyName": "기존 노트 트리 태그키",
	"setting.treeTagKeyDesc":
		"노트 전용 트리의 단일 축으로 사용할 태그키를 고릅니다. 중첩 태그 트리는 계속 모든 태그키를 표시합니다.",
	"setting.treeLabelName": "사이드바 뷰 이름",
	"setting.treeLabelDesc":
		"트리 뷰 탭의 표시 이름. 비우면 기본값을 씁니다. 코어 '탐색기'와 같은 이름은 피하세요.",
	"setting.headerButtonsName": "트리 동작",
	"setting.headerButtonsDesc":
		"각 동작을 헤더나 더보기 메뉴에 표시할지 정합니다.",
	"setting.hb.newNote": "새 노트",
	"setting.hb.sort": "정렬 방향",
	"setting.hb.collapseAll": "전체 접기 / 펼치기",
	"setting.hb.showCurrent": "현재 파일 보기",
	"setting.hb.bootstrap": "기존 파일명 편입",
	"setting.hb.cascade": "하위 위치 함께 변경",
	"setting.hb.undo": "되돌리기",
	"setting.sortName": "트리 정렬 기준",
	"setting.sortDesc": "트리 정렬 순서 (오름/내림차순은 패널 헤더에서 전환).",
	"setting.sortTagkey": "파일명 코드",
	"setting.sortMtime": "수정 시간",
	"setting.sortCtime": "생성 시간",
	"setting.langName": "언어",
	"setting.langDesc": "UI 언어. '자동'은 옵시디언 언어를 따릅니다.",
	"setting.langAuto": "자동",
	// tree view
	"tree.newNote": "새 노트",
	"tree.sortAsc": "정렬: 오름차순 (클릭하면 내림차순)",
	"tree.sortDesc": "정렬: 내림차순 (클릭하면 오름차순)",
	"tree.collapseAll": "전체 접기 / 펼치기",
	"tree.showCurrent": "현재 파일 보기",
	"tree.bootstrap": "기존 파일명 편입…",
	"tree.cascade": "하위 위치 함께 변경",
	"tree.undo": "되돌리기…",
	"tree.empty": "위치 태그가 붙은 노트가 없습니다.",
	// bootstrap select modal
	"modal.bootstrapSelect.title": "부트스트랩 — 대상 선택",
	"modal.bootstrapSelect.desc":
		'부트스트랩할 폴더나 노트를 고르세요. 폴더를 체크하면 그 안 모든 노트가 선택됩니다. 노트는 개별 토글할 수 있고, 폴더와 노트를 섞어 고를 수도 있습니다. 전체는 "전체 선택"을 쓰세요. 다음 단계에서 기록 전 미리보기합니다.',
	"modal.bootstrapSelect.selectAll": "전체 선택",
	"modal.bootstrapSelect.clear": "선택 해제",
	"modal.bootstrapSelect.next": "다음 — 미리보기 ({n})",
	"modal.bootstrapSelect.untaggedOnly": "태그 없는 노트만 보기",
	"modal.bootstrapSelect.empty": "표시할 노트가 없습니다.",
	"modal.bootstrapSelect.tagged": "✓ 태그됨",
	"ph.bootstrapSearch": "이름으로 노트 검색…",
	"notice.bootstrapNoSelection": "선택된 항목이 없습니다",
	// bulk progress modal (0.2.0)
	"bulk.pause": "일시정지",
	"bulk.resume": "재개",
	"bulk.cancel": "중단",
	"bulk.elapsed": "{sec}초 경과",
	"bulk.errors": "오류 {n}건",
	"bulk.slowHint":
		"느린가요? 보통 대상 수가 많거나 파일 I/O가 느린 경우입니다 (예: 클라우드 동기화 볼트).",
	"bulk.title.bootstrap": "부트스트랩 적용 중",
	"bulk.title.separator": "구분자 변경 중",
	"bulk.title.namespace": "네임스페이스 변경 중",
	"bulk.title.namespaceUndo": "네임스페이스 변경 되돌리는 중",
	"bulk.unexpectedFailure": "예기치 않은 마이그레이션 실패",
	"bulk.progress": "{done} / {total}",
	"bulk.done": "완료",
	"bulk.rolledBack": "롤백됨",
	"bulk.cancelledLabel": "중단됨",
	"bulk.ok": "확인",
	"bulk.summary": "{done}개 처리 · {skipped}개 건너뜀",
	"bulk.skippedTitle": "건너뛴 노트 ({n})",
	"bulk.skippedDesc":
		"노트 상태 변경, 대상 파일명 충돌 또는 frontmatter 읽기 실패로 적용하지 않았습니다. 아래 노트를 확인한 뒤 다시 실행하세요.",
	"notice.bootstrapCancelled":
		'부트스트랩 중단 — {n}개 파일은 이미 태그됨 ("마지막 부트스트랩 되돌리기"로 취소 가능)',
	"notice.sepCancelled":
		'구분자 변경 중단 — {n}개 파일은 이미 변경됨 ("마지막 구분자 변경 되돌리기"로 취소 가능)',
	// advanced multi-key slot editor (0.2.0, experimental)
	"setting.advName": "고급 — 멀티키 슬롯 (시험 기능)",
	"setting.advDesc":
		"파일명을 키 슬롯 배열로 편집합니다. 각 태그키 슬롯은 자기 네임스페이스에서 동기화되고 네임키는 자유 제목으로 남습니다. 적용 전 정확한 이름 변경 목록을 보여주고 한 번에 실행하며 되돌릴 수 있습니다.",
	"setting.advSlots": "슬롯",
	"adv.slot": "슬롯 {n}",
	"adv.roleTag": "태그키",
	"adv.roleName": "네임키 (자유 제목)",
	"adv.nsPh": "네임스페이스, 예: trel",
	"adv.sep": "구분자 {n} (슬롯 {a}·{b} 사이)",
	"adv.addTag": "태그키 슬롯 추가",
	"adv.addName": "네임키 슬롯 추가",
	"adv.moveUp": "위로",
	"adv.moveDown": "아래로",
	"adv.remove": "슬롯 삭제",
	"adv.addSlot": "슬롯 추가",
	"adv.pending": "적용 대기 중인 변경",
	"adv.apply": "적용",
	"adv.revert": "되돌리기",
	"adv.invalidTitle": "잘못된 스키마",
	"adv.invalid.needTag": "태그키 슬롯이 최소 1개 필요합니다.",
	"adv.invalid.oneName": "네임키 슬롯은 1개까지만 지원합니다.",
	"adv.invalid.nsEmpty": "태그 슬롯의 네임스페이스는 비울 수 없습니다.",
	"adv.invalid.nsBad": "네임스페이스 '{ns}' 에 사용할 수 없는 문자가 있습니다 — 영문·숫자·'-'·'_'만 됩니다.",
	"adv.invalid.nsDup": "네임스페이스 '{ns}' 가 둘 이상의 태그 슬롯에서 쓰입니다.",
	"adv.invalid.sep": "구분자 {n} 이 비어 있거나 사용할 수 없는 문자를 포함합니다.",
	"adv.invalid.spacing": "구분자 {n} 의 공백 설정이 올바르지 않습니다.",
	"adv.invalid.conflict":
		"태그 계층 구분자와 인접한 슬롯 경계 기호가 공백 없이 같습니다. 둘 중 하나를 바꾸거나 경계 공백을 추가하세요.",
	"notice.advApplied": "스키마를 적용했습니다",
	"modal.ok": "확인",
	"modal.confirm.dontAsk": "다시 묻지 않기",
	"modal.confirm.ok": "적용",
	"modal.confirm.cancel": "취소",
	"modal.badSep.title": "잘못된 구분자",
	"modal.badSep.desc": "구분자는 비울 수 없고, 영문·숫자·공백이나 파일명에 쓸 수 없는 기호는 넣을 수 없습니다. -, _, ., ~ 같은 기호를 쓰세요.",
	"modal.badSep.conflict":
		"태그 계층 구분자와 인접한 슬롯 경계 기호가 공백 없이 같아서 파일명을 구분할 수 없습니다. 기호 하나를 바꾸거나 경계에 공백을 추가하세요.",
	"modal.applySchema.title": "스키마 변경을 적용할까요?",
	"modal.applySchema.desc": "파일명 규칙을 갱신합니다. 기존 파일은 태그가 바뀔 때 다시 동기화되며, 지금 당장 이름이 바뀌지는 않습니다.",
	"setting.statsName": "현재 볼트 현황",
	"setting.statsDesc":
		"전체 {total}개 중 관리 노트 {managed}개 · 관리 태그값 {tags}개 · 고유 경로 {paths}개. 설정창을 연 동안 자동 갱신됩니다.",
	"setting.statsGeneralName": "일반 태그",
	"setting.statsGeneralDesc": "명시적 사용 {tags}개 · 고유 태그 {unique}개",
	"setting.statsKeyName": "슬롯 {n} 태그키 · #{ns}/…",
	"setting.statsKeyDesc":
		"노트 {notes}개 · 태그값 {tags}개 · 고유 경로 {paths}개 · 중복 노트 {duplicates}개 · 인라인 전용 노트 {inline}개 · 네임스페이스 노드 노트 {roots}개",
	"setting.statsPaths": "사용량 상위 경로 ({n})",
	"setting.statsMore": "외 {n}개 경로",
	"setting.statsRootUnknownName": "루트 아래 미등록 태그",
	"setting.statsRootUnknownDesc":
		"공통 루트 아래 있지만 어느 태그키 네임스페이스에도 속하지 않는 명시적 태그가 {n}개 있습니다.",
	"notice.advLastTag": "태그키 슬롯은 최소 1개 필요합니다",
	"notice.advOneName": "네임키 슬롯은 1개까지만 지원합니다",
	"notice.advNsEmpty": "태그 슬롯 네임스페이스는 비울 수 없습니다",
	"notice.advNsDup": "태그 슬롯 네임스페이스는 서로 달라야 합니다",
	"notice.advReset": "스키마를 단일키(태그+네임)로 재설정했습니다",
	"setting.experimentalName": "실험 기능 — 파일명 확장",
	"setting.experimentalDesc":
		"소유 루트, ID 자동 제안, 둘 이상의 관리 키가 꼭 필요한 볼트를 위한 선택 기능입니다. 일반적인 단일키 볼트는 닫아 두어도 됩니다.",
	// root namespace (0.3.0 experimental, B25)
	"setting.rootName": "루트 네임스페이스 (시험 기능)",
	"setting.rootDesc":
		'모든 관리 태그가 시작하는 단일 소유 루트 (예: "trellis" → #trellis/tree/…). 비우면 기존 무루트 형태. 적용하면 볼트의 관리 태그 전체를 마이그레이션합니다(되돌리기 가능). 파일명은 바뀌지 않습니다.',
	"cmd.rootUndo": "마지막 루트 네임스페이스 변경 되돌리기",
	"modal.root.title": "루트 네임스페이스를 변경할까요?",
	"modal.root.desc":
		'"{from}" → "{to}": {n}개 노트의 관리 위치 태그를 다시 씁니다. 파일명은 그대로이고 태그의 소유 층만 이동합니다. 되돌릴 수 있습니다.',
	"notice.rootChanged": '루트 네임스페이스 "{from}" → "{to}", {n}개 노트 변경',
	"notice.rootUndone": "{n}개 노트의 루트 네임스페이스를 되돌렸습니다",
	"notice.noRootChange": "되돌릴 루트 네임스페이스 변경 없음",
	"notice.rootBadChar":
		"루트 네임스페이스는 영문·숫자·'-'·'_'만 쓸 수 있습니다 ('/'·공백·기호 불가)",
	"bulk.title.root": "루트 네임스페이스 변경 중",
	"bulk.title.cascade": "위치 태그 이름 변경 중",
	"bulk.title.cascadeUndo": "위치 태그 이름 변경 되돌리는 중",
	// ID scheme presets (0.3.0 experimental, B26)
	"setting.schemeName": "ID 자동 제안 (시험 기능)",
	"setting.schemeDesc":
		"1번 태그 슬롯의 선택적 프리셋. 새 노트의 다음 세그먼트를 제안하고 부트스트랩 파싱을 정확하게 합니다. 실시간 동기화는 어느 쪽이든 형식-무지 그대로입니다.",
	"scheme.none": "없음 (형식-무지)",
	"scheme.spark": "영문/숫자 교대 (S/88/B/07)",
	"scheme.zettel": "제텔카스텐 타임스탬프 (YYYYMMDDHHMMSS)",
	"scheme.date": "날짜 (YYYYMMDD)",
	"scheme.seq": "순번 (1, 2, 3…)",
	"adv.scheme": "ID 스킴",
	// nested tag view (0.3.0 experimental, B24)
	"setting.treeModeName": "트리 뷰 모드",
	"setting.treeModeDesc":
		"노트: 실제 노트만, 세그먼트 층 투명 (기존 방식). 태그: 코어 태그창처럼 중첩 태그 계층 전체를 폴더식으로.",
	"setting.treeModeNotes": "노트 (기존)",
	"setting.treeModeTags": "중첩 태그",
	"setting.showRootName": "네임스페이스 층 표시 (중첩 모드)",
	"setting.showRootDesc":
		"루트/네임스페이스 태그(예: tree)를 최상위 행으로 보일지, 바로 계층부터 시작할지.",
	"setting.untaggedName": "무태그 노트 표시 (중첩 모드)",
	"setting.untaggedDesc":
		"관리 위치 태그가 없는 노트를 하단 섹션에 나열해 온보딩 누락을 보이게 합니다.",
	"setting.labelModeName": "행 표시 형식 (중첩 모드)",
	"setting.labelModeDesc": "노트 행에 파일명을 보일지, 태그 세그먼트만 보일지.",
	"setting.labelModeFilename": "파일명",
	"setting.labelModeTag": "태그 세그먼트만",
	"setting.hb.viewMode": "뷰 모드 전환",
	"tree.modeToNotes": "노트 뷰로 전환",
	"tree.modeToTags": "중첩 태그 뷰로 전환",
	"tree.more": "더보기",
	"tree.undoCount": "{action} — {n}개 노트",
	"tree.untagged": "무태그 노트 ({n})",
};

const STRINGS: Record<Lang, Record<string, string>> = { en: EN, ko: KO };
