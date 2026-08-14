# 보호된 자동화

[English](automation.md)

Trellis 0.4는 실행 중인 Obsidian 앱에 이미 접근할 수 있는 AI 도구나 스크립트를
위해 실험적인 프로세스 내부 표면을 제공합니다. 한 번에 검토 가능한 노트 하나를
바꾸도록 설계했습니다.

```text
inspectNote → planChange → applyChange
```

네트워크 API가 아닙니다. Trellis는 REST server, URI handler, MCP server,
원격조작 port를 열지 않습니다. 신뢰할 수 있는 로컬 개발 도구처럼 Obsidian의
JavaScript 프로세스 안에서 이미 실행되는 호출자만 사용할 수 있습니다.

> **참고**
> Trellis 1.0 전까지는 실험 기능입니다. 플러그인 버전을 고정하고 반환 필드가
> 영구 불변이라고 가정하지 말고 실제 결과를 검사하세요.

## 접근

Obsidian 개발자 콘솔이나 신뢰할 수 있는 프로세스 내부 호출자에서:

```js
const trellis = app.plugins.plugins.trellis;
const automation = trellis.automation;
```

두 값 중 하나가 없다면 Trellis가 설치·활성화·로드되지 않은 상태입니다. 플러그인의
private method에 직접 접근하지 말고 동결된 `automation` 객체만 사용하세요.

## 1. 검사

검사는 읽기 전용입니다.

```js
const inspected = automation.inspectNote("Projects/S88B07-회의록.md");

if (!inspected.ok) {
  console.error(inspected.error.code, inspected.error.message);
} else {
  console.log(inspected.value);
}
```

성공 결과에는 현재 경로·파일명·수정 시각·frontmatter와 cache-visible 태그,
해석된 태그/이름 슬롯, 예상 파일명, filename drift·관리 태그 중복·관리 inline
태그 등의 문제가 포함됩니다.

## 2. 계획

계획도 읽기 전용입니다. 태그 변경은 논리적 슬롯 네임스페이스와 `#` 없는 전체
목표 태그 경로를 지정합니다.

```js
const planned = automation.planChange({
  path: "Projects/S88B07-회의록.md",
  tagChanges: [
    { namespace: "trel", tagPath: "trel/S88/B99" },
  ],
  nameChange: "회의록",
});

if (planned.ok) console.log(planned.value);
```

- 유지할 부분은 `tagChanges`나 `nameChange`를 생략합니다.
- 해당 슬롯의 frontmatter 태그를 제거하려면 `tagPath: null`을 사용합니다.
- `namespace`는 선택형 공통 루트가 아니라 슬롯 네임스페이스(`trel`)입니다.
- 루트가 설정돼 있다면 `tagPath`에는 `zettel/trel/S88/B99`처럼 루트까지
  포함합니다.
- 인덱스 노트는 빈 `nameChange`도 허용됩니다.

성공한 계획에는 정확한 전후 경로와 frontmatter 태그, 이름변경·frontmatter
쓰기 필요 여부, `ready` 또는 `noop` 상태가 들어 있습니다. 계획을 만들 때 사용한
노트와 Trellis schema의 snapshot도 함께 가집니다.

## 3. 적용

검토한 계획 객체를 그대로 적용합니다.

```js
if (!planned.ok) throw new Error(planned.error.message);

const applied = await automation.applyChange(planned.value);
if (!applied.ok) {
  console.error(applied.error.code, applied.error.message, applied.error.details);
} else {
  console.log(applied.value.status, applied.value.path);
}
```

계획을 손으로 만들거나 수정하지 마세요. Trellis는 원래 요청에서 계획을 다시
계산하고 결과가 변조됐으면 거부합니다.

## 안전 계약

- 한 호출은 Markdown 노트 하나만 변경합니다.
- `inspectNote`와 `planChange`는 쓰지 않습니다.
- 적용 직전에 경로·파일명·수정 시각·frontmatter 태그·전체 Trellis schema를
  다시 확인합니다.
- 계획 이후 노트나 schema가 바뀌면 쓰지 않고 `stale-plan`을 반환합니다.
- 알 수 없는 네임스페이스, 역변환 불가능한 태그 경로, 파일명 금지 문자, 관리
  위치 중복, 관리 inline 태그 충돌, 목표 경로 충돌을 거부합니다.
- frontmatter는 Obsidian API로 쓰고 이름변경은 링크 안전 file manager를
  사용합니다.
- frontmatter를 쓴 뒤 이름변경이 실패하면 이전 frontmatter 복원을 시도하고,
  롤백까지 실패하면 그 내용도 보고합니다.
- 자동화 적용은 서로 간에, 그리고 Trellis 일괄 작업과 전역 직렬화합니다. 경쟁
  요청은 `write-in-progress`를 반환합니다.

주요 오류 코드는 `note-not-found`, `metadata-unavailable`, `invalid-request`,
`stale-plan`, `write-in-progress`, `inline-tag-conflict`,
`duplicate-location-tags`, `target-exists`,
`frontmatter-write-failed`, `rename-failed`입니다. 항상 `ok`로 분기하고 구조화된
오류를 로그에 보존하세요.

## 운영 지침

- 검사·사람/도구 검토·계획·적용 사이의 시간을 짧게 유지합니다.
- 오래된 계획을 재시도하지 말고 다시 계획합니다.
- 적용 전 계산된 경로와 태그 변경을 사용자에게 보여줍니다.
- 하위 트리·네임스페이스·루트·파일명 형식 변경은 Trellis의 내장 일괄 UI를
  사용합니다. 이 표면은 무인 batch 변경을 의도적으로 제공하지 않습니다.
- 모든 자동 편집 workflow에서 일반적인 볼트 백업을 유지합니다.
