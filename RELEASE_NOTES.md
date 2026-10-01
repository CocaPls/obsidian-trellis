# Trellis 0.7.0: filename rules and optional display names

[English](#whats-new) | [한국어](#한국어)

## What's new

- Extend filename structures with an optional free title and per-slot placement.
  Tag slots can affect the physical filename or contribute only to the displayed name.
- Optionally show Trellis names in the file explorer, tabs, note titles, search
  results, backlinks, and Quick Switcher. Quick Switcher can find display names.
- Configure each display surface separately. All six display options start off.
- Review filename changes before applying an edited naming structure. The
  current-note preview appears while structure edits are pending.
- Inspect naming projections and blocked metadata without changing notes.

## Reliability improvements

- Reject stale change previews when files, tags, or naming rules have changed.
- Preserve newer tag edits when an automatic rename fails, and report incomplete
  recovery instead of overwriting those edits.
- Clarify cancellation and recovery results for bulk operations.
- Select individual bootstrap notes using touch, pen, or keyboard, while
  retaining mouse drag selection and Shift-range selection.
- Block Windows reserved filenames, including superscript device names, and
  destinations that collide by letter case or canonical Unicode spelling.
  Check collisions both before bulk changes and immediately before renaming.
- Restore normal labels when display options or the plugin are disabled, and
  clean up queued callbacks and window-specific event handlers on unload.

## Updating from 0.5.2

Existing settings are migrated when loaded. Keep a backup of your vault and the
Trellis plugin settings before applying bulk filename changes. Updating does not
turn on the new native display options automatically.

Changing a slot between physical filename and display-only mode can change
existing filenames after you confirm the structure change. Turning a native
display switch on or off changes labels only; it does not change stored filenames
or link destinations. Custom link aliases, link text, bookmarks, Graph, and Canvas
are outside the native display-name feature.

## Compatibility

Requires Obsidian 1.8.7 or newer. Core filename and display-only flows were tested
on macOS with Obsidian 1.8.7 and 1.13.7. Windows Obsidian UI and physical Android
and iOS execution have not been tested for this version.

Native display names use Obsidian's internal view structure as well as its public
APIs. Compatibility can vary with app versions, themes, and other display plugins.

## Recovery and support

Disabling Trellis restores the native labels it decorates; it does not undo
physical file renames. Use the relevant undo operation when available. To restore
a vault backup, stop Trellis first and restore the related notes and plugin
settings together. Replacing only the plugin executable with an older version
does not restore renamed notes or earlier settings.

For a problem report, include the Obsidian version, operating system, steps, and a
small non-sensitive example of the naming rules and tags involved:
https://github.com/CocaPls/obsidian-trellis/issues

---

## 한국어

### 새 기능

- 이름 구성에서 자유 제목을 생략할 수 있고, 각 태그 칸을 실제 파일명에
  넣을지 화면 표시명에만 넣을지 선택할 수 있습니다.
- 파일 탐색기·탭·노트 제목·검색 결과·백링크·빠른 전환기에 Trellis 표시명을
  선택적으로 보여 줍니다. 빠른 전환기는 표시명으로도 노트를 찾습니다.
- 여섯 표시 옵션은 각각 설정하며, 새 설치에서는 모두 꺼져 있습니다.
- 이름 규칙을 수정하면 적용 전에 실제 변경할 파일 목록을 보여 줍니다.
  현재 노트의 이름 미리보기는 규칙 수정이 적용되지 않은 동안에 나타납니다.
- 파일명 칸 검사로 실제 이름·계산한 이름·변경을 막는 태그 문제를 비교합니다.
  검사를 여는 것만으로 노트가 바뀌지는 않습니다.

### 안정성 개선

- 미리보기 뒤에 파일·태그·이름 규칙이 달라지면 오래된 변경 계획을 거부합니다.
- 자동 이름 변경 실패 시 그 사이에 입력한 새 태그를 보존하며, 복구가 끝나지
  않은 경우 확인이 필요한 내용을 보고합니다.
- 일괄 작업의 취소와 복구 결과를 구체적으로 표시합니다.
- 기존 파일명 가져오기에서 터치·펜·키보드로 개별 노트를 선택할 수 있습니다.
  마우스 드래그와 Shift 범위 선택도 유지합니다.
- Windows 예약 파일명과 위첨자 장치 이름을 차단하고, 대소문자나 유니코드
  표기만 다른 이름의 충돌도 일괄 작업 전과 실제 이름 변경 직전에 검사합니다.
- 표시 옵션이나 플러그인을 끄면 원래 화면 이름으로 돌아갑니다.
  플러그인 종료 시 대기 중인 처리와 창별 이벤트 연결을 정리합니다.

### 0.5.2에서 업데이트

이전 설정은 불러올 때 변환합니다. 많은 파일명을 바꾸기 전에는 볼트와
Trellis 설정을 함께 백업하세요. 업데이트해도 새 화면 표시 옵션이 자동으로
켜지지 않습니다.

태그 칸을 실제 파일명과 표시 전용 사이에서 전환하면, 이름 규칙 변경을
확인하고 적용한 뒤 기존 파일명이 바뀔 수 있습니다. 여섯 화면 표시 스위치는
글자가 보이는 방식만 바꾸며 파일명과 링크 목적지를 바꾸지 않습니다.
링크 글자·사용자 별칭·북마크·그래프·캔버스는 이 표시 기능의 대상이 아닙니다.

### 지원 환경과 확인 범위

Obsidian 1.8.7 이상이 필요합니다. macOS의 Obsidian 1.8.7과 1.13.7에서 핵심
파일명·표시 전용 흐름을 시험했습니다. 이 버전의 Windows Obsidian 화면과
실제 Android·iOS 기기 실행은 시험하지 않았습니다.

기본 화면 표시명은 공개 API와 함께 Obsidian 내부 화면 구조를 사용합니다.
앱 버전·테마·다른 표시 플러그인에 따라 호환성을 따로 확인해야 할 수 있습니다.

### 복구와 문제 제보

Trellis를 끄면 바꿔 표시하던 화면 이름이 돌아옵니다. 이미 바뀐 실제 파일명은
그대로이므로 해당 되돌리기 작업을 사용해야 합니다. 백업을 복구하려면
Trellis를 먼저 끄고 관련 노트와 플러그인 설정을 함께 복구하세요. 실행 파일만
이전 버전으로 바꾸는 것은 파일명과 설정을 복구하지 않습니다.

문제 제보에는 Obsidian 버전·운영체제·재현 순서와 개인정보를 제외한 작은
이름 규칙·태그 예를 포함해 주세요:
[GitHub Issues](https://github.com/CocaPls/obsidian-trellis/issues).
