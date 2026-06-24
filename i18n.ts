/**
 * Tiny i18n layer. Strings live in a per-language dictionary; t() looks up the
 * active language and falls back to English for any missing key. The active
 * language is resolved once at load (and on a settings change) from either an
 * explicit override or Obsidian's own UI language.
 */

export type Lang = "en" | "ko";
/** Settings value: "auto" follows Obsidian; "en"/"ko" force a language. */
export type LangSetting = "auto" | "en" | "ko";

/** Read Obsidian's UI language. Obsidian stores it in localStorage under
 *  "language" (empty/absent = English default; "ko" = Korean, etc.). This is an
 *  unofficial but stable key the app has used for years. */
function detectObsidianLang(): Lang {
	try {
		const stored = window.localStorage.getItem("language");
		if (stored && stored.toLowerCase().startsWith("ko")) return "ko";
	} catch {
		/* localStorage unavailable — fall through to default */
	}
	return "en";
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
	"cmd.cascade": "Rename location tag (cascade)",
	"cmd.bootstrapPreview": "Bootstrap: preview tag assignment (dry-run)",
	"cmd.bootstrapUndo": "Undo last bootstrap",
	// view / ribbon
	"view.treeName": "TRELLIS tree",
	// notices
	"notice.treeOff": "TRELLIS: tree view is off (enable it in settings)",
	"notice.renamed": "TRELLIS: {from} → {to}",
	"notice.renameFailed": "TRELLIS: rename failed for {name}",
	"notice.noTrekey": "TRELLIS: could not derive trekey (check namespace)",
	"notice.exists": 'TRELLIS: "{base}" already exists',
	"notice.createFailed": 'TRELLIS: failed to create "{base}"',
	"notice.retagged": "TRELLIS: retagged {n} file(s) {from} → {to}",
	"notice.noFilesTagged": "TRELLIS: no files tagged {from}",
	"notice.bootstrapped":
		'TRELLIS: bootstrapped {n} file(s). Undo via "Undo last bootstrap".',
	"notice.noBootstrap": "TRELLIS: no bootstrap to undo",
	"notice.undid": "TRELLIS: undid bootstrap on {n} file(s)",
	"notice.fillBoth": "TRELLIS: fill in both fields",
	"notice.parentRequired": "TRELLIS: parent is required",
	"notice.segmentRequired": "TRELLIS: segment is required",
	"notice.nsEmpty": "TRELLIS: namespace cannot be empty",
	"notice.sepOneChar": "TRELLIS: separator must be exactly one character",
	// menu
	"menu.newHere": "New note here",
	// cascade modal
	"modal.cascade.title": "Rename location tag (cascade)",
	"modal.cascade.desc":
		"Rewrites this tag and everything under it across the vault. Filenames follow automatically.",
	"modal.cascade.fromName": "From",
	"modal.cascade.fromDesc": "Existing tag — type to search, ↑↓ + Enter to pick",
	"modal.cascade.toName": "To",
	"modal.cascade.toDesc": "New tag path (free text)",
	"modal.cascade.submit": "Rename",
	// new-note modal
	"modal.newNote.title": "New note",
	"modal.newNote.desc":
		"Create a note under a location tag. The parent is prefilled from the active note (editable, autocompleted). You assign the segment yourself — TRELLIS does not guess the trekey scheme.",
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
		"{assign} file(s) would get a tag · {already} already tagged (skipped) · {none} have no recognizable trekey (skipped). Nothing is written.",
	"modal.bootstrap.willAssign": "Will assign ({n})",
	"modal.bootstrap.noTrekey": "No trekey — skipped, check manually ({n})",
	"modal.bootstrap.apply": "Apply — tag {n} file(s)",
	"modal.bootstrap.close": "Close",
	// settings
	"setting.nsName": "Location tag namespace",
	"setting.nsDesc":
		"Tags under this namespace are the source of truth. e.g. 'trel' → #trel/S88/B07",
	"setting.sepName": "Separator",
	"setting.sepDesc": "Single character between the trekey and the title. e.g. '-'",
	"setting.posName": "Key position",
	"setting.posDesc": "Where the trekey sits in the filename.",
	"setting.posPrefix": "Prefix — start of filename (S88B07-title)",
	"setting.posSuffix": "Suffix — end of filename (title-S88B07)",
	"setting.treeName": "Sidebar tree view",
	"setting.treeDesc":
		"Show a collapsible tree of the location-tag hierarchy in the sidebar (ribbon icon + command).",
	"setting.sortName": "Tree sort by",
	"setting.sortDesc":
		"Sort order in the tree (ascending/descending is toggled in the panel header).",
	"setting.sortTrekey": "Trekey (name)",
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
	"tree.empty": "No location-tagged notes found.",
};

const KO: Record<string, string> = {
	// commands
	"cmd.openTree": "트리 뷰 열기",
	"cmd.cascade": "위치 태그 이름 변경 (하위 전체)",
	"cmd.bootstrapPreview": "부트스트랩: 태그 부여 미리보기 (드라이런)",
	"cmd.bootstrapUndo": "마지막 부트스트랩 되돌리기",
	// view / ribbon
	"view.treeName": "TRELLIS 트리",
	// notices
	"notice.treeOff": "TRELLIS: 트리 뷰가 꺼져 있습니다 (설정에서 켜세요)",
	"notice.renamed": "TRELLIS: {from} → {to}",
	"notice.renameFailed": "TRELLIS: {name} 이름 변경 실패",
	"notice.noTrekey": "TRELLIS: 트리키를 도출할 수 없습니다 (네임스페이스 확인)",
	"notice.exists": 'TRELLIS: "{base}" 이(가) 이미 있습니다',
	"notice.createFailed": 'TRELLIS: "{base}" 생성 실패',
	"notice.retagged": "TRELLIS: {n}개 파일 재태그 {from} → {to}",
	"notice.noFilesTagged": "TRELLIS: {from} 태그가 붙은 파일 없음",
	"notice.bootstrapped":
		'TRELLIS: {n}개 파일 부트스트랩 완료. "마지막 부트스트랩 되돌리기"로 취소.',
	"notice.noBootstrap": "TRELLIS: 되돌릴 부트스트랩 없음",
	"notice.undid": "TRELLIS: {n}개 파일 부트스트랩 되돌림",
	"notice.fillBoth": "TRELLIS: 두 칸 모두 입력하세요",
	"notice.parentRequired": "TRELLIS: 부모가 필요합니다",
	"notice.segmentRequired": "TRELLIS: 세그먼트가 필요합니다",
	"notice.nsEmpty": "TRELLIS: 네임스페이스는 비울 수 없습니다",
	"notice.sepOneChar": "TRELLIS: 구분자는 한 글자여야 합니다",
	// menu
	"menu.newHere": "여기에 새 노트",
	// cascade modal
	"modal.cascade.title": "위치 태그 이름 변경 (하위 전체)",
	"modal.cascade.desc":
		"이 태그와 그 하위 전체를 볼트에서 다시 씁니다. 파일명은 자동으로 따라갑니다.",
	"modal.cascade.fromName": "변경 전",
	"modal.cascade.fromDesc": "기존 태그 — 입력해 검색, ↑↓ + Enter로 선택",
	"modal.cascade.toName": "변경 후",
	"modal.cascade.toDesc": "새 태그 경로 (자유 입력)",
	"modal.cascade.submit": "이름 변경",
	// new-note modal
	"modal.newNote.title": "새 노트",
	"modal.newNote.desc":
		"위치 태그 아래에 노트를 만듭니다. 부모는 현재 노트 기준으로 미리 채워집니다 (수정·자동완성 가능). 세그먼트는 직접 지정하세요 — TRELLIS는 트리키 스킴을 추측하지 않습니다.",
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
		"{assign}개 파일에 태그 부여 예정 · {already}개 이미 태그됨 (건너뜀) · {none}개 트리키 인식 불가 (건너뜀). 아무것도 기록하지 않습니다.",
	"modal.bootstrap.willAssign": "부여 예정 ({n})",
	"modal.bootstrap.noTrekey": "트리키 없음 — 건너뜀, 수동 확인 ({n})",
	"modal.bootstrap.apply": "적용 — {n}개 파일 태그",
	"modal.bootstrap.close": "닫기",
	// settings
	"setting.nsName": "위치 태그 네임스페이스",
	"setting.nsDesc":
		"이 네임스페이스 아래 태그가 진실원입니다. 예: 'trel' → #trel/S88/B07",
	"setting.sepName": "구분자",
	"setting.sepDesc": "트리키와 제목 사이의 한 글자. 예: '-'",
	"setting.posName": "키 위치",
	"setting.posDesc": "파일명에서 트리키가 놓이는 위치.",
	"setting.posPrefix": "접두 — 파일명 앞 (S88B07-제목)",
	"setting.posSuffix": "접미 — 파일명 뒤 (제목-S88B07)",
	"setting.treeName": "사이드바 트리 뷰",
	"setting.treeDesc":
		"위치 태그 계층을 사이드바에 접을 수 있는 트리로 표시합니다 (리본 아이콘 + 명령).",
	"setting.sortName": "트리 정렬 기준",
	"setting.sortDesc": "트리 정렬 순서 (오름/내림차순은 패널 헤더에서 전환).",
	"setting.sortTrekey": "트리키 (이름)",
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
	"tree.empty": "위치 태그가 붙은 노트가 없습니다.",
};

const STRINGS: Record<Lang, Record<string, string>> = { en: EN, ko: KO };
