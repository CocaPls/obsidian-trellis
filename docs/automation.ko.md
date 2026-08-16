# 보호된 자동화

[English](automation.md)

Trellis 0.5는 실행 중인 Obsidian 앱에 이미 접근할 수 있는 AI 도구나 스크립트를
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

계획 전에 현재의 안정 ID와 파일명 구조를 읽습니다.

```js
const model = automation.describe();
console.log(model.tagDefinitions, model.filenameSlots, model.filenameSyncEnabled);
```

각 태그 정의에는 안정 ID와 현재 `archived` 상태가 포함됩니다. 보관된 정의도 기존
태그를 안전하게 제거할 수 있도록 계속 식별되지만 새 값을 받을 활성 대상은 아닙니다.

`filenameSlots`에는 태그 슬롯별 파일명 전용 표시 필드도 들어 있습니다.
`filenameTextTransform: "underscore-to-space"`는 frontmatter 태그를 그대로 둔 채
파일명에서만 `_`를 일반 공백으로 표시합니다. 슬롯 `i` 뒤의 경계는
`separators[i]`와 `separatorSpacing[i]`를 함께 읽습니다.

- 비어 있지 않은 separator는 설정된 주변 공백을 가진 기호입니다.
- 빈 separator와 `"after"`는 일반 공백 한 칸입니다.
- 빈 separator와 `"none"`은 채워진 슬롯을 바로 붙입니다.

비어 있는 슬롯은 사용되지 않는 경계와 함께 접힙니다.

## 1. 검사

검사는 읽기 전용입니다.

```js
const inspected = automation.inspectNote("Projects/PRJ01DOC01-회의록.md");

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

계획도 읽기 전용입니다. `describe()`가 반환한 안정적인 관리 태그 정의 ID와 `#`
없는 전체 목표 태그 경로를 우선 사용합니다.

```js
const planned = automation.planChange({
  path: "Projects/PRJ01DOC01-회의록.md",
  tagChanges: [
    { tagDefinitionId: "tag-projects", tagPath: "projects/PRJ/01/DOC/02" },
  ],
  nameChange: "회의록",
});

if (planned.ok) console.log(planned.value);
```

- 유지할 부분은 `tagChanges`나 `nameChange`를 생략합니다.
- 해당 슬롯의 frontmatter 태그를 제거하려면 `tagPath: null`을 사용합니다.
- 검토한 태그 전용 변경은 `syncFilename: false`를 지정합니다. 플러그인 표면에서
  생략하면 현재 전역 파일명 동기화 설정을 따릅니다.
- 네임키 없는 스키마에서 마지막 관리 태그를 제거하면 노트가 트렐리 관리 밖으로
  나갑니다. 검토한 요청에 `allowUnmanaged: true`를 명시하지 않으면
  `would-unmanage-note`로 차단하며, 명시한 경우 현재 파일명을 보존합니다.
- `namespace`도 호환 조회용으로 남지만 안정적인 `tagDefinitionId`를 권장합니다.
  ID 방식은 파일명 슬롯이 없는 사이드바 전용 트렐리 태그도 바꿀 수 있습니다.
- 보관된 정의는 `tagPath: null`만 허용합니다. 값을 넣거나 바꾸면 설정에서 정의를
  복원하기 전까지 `archived-namespace`를 반환합니다.
- 루트가 설정돼 있다면 `tagPath`에는 `work/projects/PRJ/01/DOC/02`처럼 루트까지
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
- 알 수 없는 정의 ID/네임스페이스, 역변환 불가능한 태그 경로, 파일명 금지 문자, 관리
  위치 중복, 관리 inline 태그 충돌, 목표 경로 충돌을 거부합니다.
- frontmatter는 Obsidian API로 쓰고 이름변경은 링크 안전 file manager를
  사용합니다.
- frontmatter를 쓴 뒤 이름변경이 실패하면 이전 frontmatter 복원을 시도하고,
  롤백까지 실패하면 그 내용도 보고합니다.
- 자동화 적용은 서로 간에, 그리고 Trellis 일괄 작업과 전역 직렬화합니다. 경쟁
  요청은 `write-in-progress`를 반환합니다.
- 같은 노트에서 연속된 메타데이터 이벤트는 실시간 동기화 전에 합칩니다. 여러 태그
  슬롯을 함께 바꾸면 최종 상태로 파일명을 한 번 계산합니다.
- 일괄 작업과 자동화 쓰기는 첫 노트를 바꾸기 전에 실행 중인 작업을 기록합니다.
  완료 전에 Obsidian이 멈추면 다음 실행에서 완료로 숨기지 않고 `interrupted`로
  보고합니다.

주요 오류 코드는 `note-not-found`, `metadata-unavailable`, `invalid-request`,
`archived-namespace`, `stale-plan`, `write-in-progress`, `inline-tag-conflict`,
`duplicate-location-tags`, `would-unmanage-note`, `target-exists`,
`frontmatter-write-failed`, `operation-record-failed`, `rename-failed`입니다. 항상 `ok`로 분기하고 구조화된
오류를 로그에 보존하세요.

## 완료 상태

대기 중인 실시간 동기화까지 끝난 뒤에만 변경 완료로 취급합니다.

```js
const settled = await automation.awaitIdle();
if (settled.needsAttention) {
  console.error(settled.attention);
  throw new Error("Trellis 작업 확인 필요");
}
```

`operationStatus()`는 기다리지 않고 `idle`, `pendingSyncs`, `current`, `last`,
`needsAttention`, `attention`을 반환합니다. 실패·부분 실패·중단 보고는 이후 작업이
성공해도 `attention`에 남습니다. 내용을 확인한 뒤에만 명시적으로 해제합니다.

```js
await automation.acknowledgeOperation(settled.attention.id);
```

`idle`은 성공과 같은 뜻이 아닙니다. 안전한 호출자는 `idle === true`와
`needsAttention === false`를 함께 확인해야 합니다.

## 운영 지침

- 검사·사람/도구 검토·계획·적용 사이의 시간을 짧게 유지합니다.
- 오래된 계획을 재시도하지 말고 다시 계획합니다.
- 적용 전 계산된 경로와 태그 변경을 사용자에게 보여줍니다.
- 하위 트리·네임스페이스·루트·파일명 형식 변경은 Trellis의 내장 일괄 UI를
  사용합니다. 이 표면은 무인 batch 변경을 의도적으로 제공하지 않습니다.
- 모든 자동 편집 workflow에서 일반적인 볼트 백업을 유지합니다.
