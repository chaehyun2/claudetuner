# 배포 전 수동 테스트 체크리스트 — 활성화 퍼널 (PR #148)

> 대상: PR #148의 **확장(팝업) 변경 개입 2·3·4**. CWS 배포 전 unpacked 로드로 검증.
> 사이트 변경(welcome CTA, nav tooltip)은 이미 main 머지로 프로덕션 라이브 → 맨 아래 §6에서 프로덕션 확인.
> 배경/진단: [docs/OVERSEAS-CHURN.md](../docs/OVERSEAS-CHURN.md)

## 0. 셋업
- [ ] `chrome://extensions` → 개발자 모드 → **압축해제된 확장 로드** → `claude-tuner-extension/`
- [ ] claude.ai 로그인 + 팝업에서 수집 1회 (실데이터 필요)
- [ ] 상태 초기화: 서비스워커 콘솔에서 `chrome.storage.local.clear()` 또는 새 프로필

## 1. 예측 헤드라인 `#predict-headline` — **최우선** (가장 복잡, Codex가 상태 소유권 지적)
| 상태 | 만드는 법 | 기대 |
|---|---|---|
| 신규 티저 | usageHistory 비우고 첫 수집 | "📈 Forecasting…" 티저, **로드 전 깜빡임 없음** (`_historyLoaded` 게이트) |
| 실제 예측 | 3회+ 수집 + 상승 추세 | "▸ N%" + 100% 예상 시 "⚠️ …5h limit · 시각" alert(빨강) |
| 안정 | 사용량 변화 거의 없음 | 헤드라인 **숨김** |
| **조직 전환** | Claude→비Claude(ChatGPT/Gemini)→Enterprise(usage-based) 칩 클릭 | 이전 조직 헤드라인 **잔존 안 함** (fix 1a) |
| **debounce 재렌더** | 비-primary 조직 선택 상태에서 상태 업데이트 | 선택 조직 헤드라인 **안 지워짐** (fix 1b) |
| 에러 | 수집 실패 유도(로그아웃 등) | 게이지와 일관(stale 잔존 허용) |
| 다크모드 | 테마 토글 | alert 색/배경 정상 |

## 2. 일회성 대시보드 nudge `#dash-nudge`
- [ ] 수집 성공 직후 게이지 위 카드 노출
- [ ] **닫기(✕)** → 사라지고 다시 안 뜸
- [ ] **링크 클릭** → 대시보드 새 탭 + 영구 종료
- [ ] 미조작 시 **최대 3회** 노출 후 자동 종료 (팝업 3번 열기)
- [ ] `storage.local`의 `dashNudge {done,shows}` 값 확인

## 3. 팝업 대시보드 진입점 시인성
- [ ] 헤더 "Analytics" 버튼: 차트 아이콘 + **hover 시 accent 채움** (라이트/다크 둘 다)
- [ ] 온보딩 블록(데이터 없을 때): 대시보드 링크가 **보조 버튼** 형태
- [ ] tooltip 언어별 정상 (영어 'Analytics' / 한국어 '상세 분석')

## 4. i18n 교차 확인 (영어가 핵심 타깃)
- [ ] en/ko 각각: 신규 문구(`dash_nudge`, `predict_headline_collecting`, `predict_headline_limit`, `dash_nudge_dismiss`) 정상 번역
- [ ] 영어 모드에서 한글 누수 없음

## 5. 회귀
- [ ] 기존 게이지 / 예측 인라인 배지 / 리셋 카운트다운 정상
- [ ] Enterprise(seat-based / usage-based), 멀티 조직 칩 전환 안 깨짐

## 6. 사이트 (이미 라이브) — 프로덕션에서 바로 확인
- [ ] `claudetuner.com/welcome/` (영어 브라우저): 수집 완료 시 "Open my dashboard" CTA + 대시보드가 같은 언어로 열림
- [ ] `?lang=en-US` 등으로 열어도 영어 렌더 + `ct-lang` 영어 저장 (Codex 지적 3)
- [ ] 대시보드 nav 언어토글 hover tooltip이 영어 유저에게 한글 안 뜸

---
1번(예측 헤드라인)이 위험도·복잡도 최상 → 시간 배분 우선. 배포는 명시적 요청 시에만(CWS).
