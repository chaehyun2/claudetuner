# Claude Tuner

[Chrome Web Store](https://chromewebstore.google.com/detail/claude-tuner/ajnnckikagphjbgpicpoffockabnhond) | [대시보드](https://claudetuner.com/dashboard/?demo=true) | [English](README.md)

Claude AI 사용량을 실시간으로 추적하는 Chrome 확장 프로그램 — 사용량 모니터링, 리셋 예측, 최적 플랜 찾기.

전 세계 수천 명의 Claude Pro, Max, Team 사용자가 이용 중입니다.

## 주요 기능

**실시간 사용량 모니터링**
- 5시간 / 7일 사용률 게이지
- 리셋 카운트다운 타이머
- 툴바 배지로 현재 사용량 표시
- 6단계 속도 표시기 (safe → critical)
- 스파크라인 차트로 추세 확인
- 멀티 조직 지원 (자동 감지 또는 고정)

**스마트 알림 & 예측**
- 현재 소비 속도 기반 리셋 시점 사용량 예측
- 임계값 알림 (80%, 95%)
- 주간 사용 리포트
- 모델별 토큰 사용량 추정 (Opus / Sonnet / Haiku)
- 피크 시간 표시기 (평일 12:00–18:00 UTC)
- 429 제한 실시간 감지

**플랜 시뮬레이션 & 최적화**
- "만약에" 시뮬레이션 (Pro / Max 5x / Max 20x)
- 플랜별 초과일 수 비교
- 업그레이드 / 다운그레이드 추천
- 비용 효율성 분석

**플랜 적합도 점수**
- 현재 구독의 적합도 한눈에 확인
- Claude Tuner 사용자 중 백분위 순위
- 사용량 분포 히스토그램

**시간대별 활동 히트맵**
- 24x7 사용 패턴 히트맵
- 피크 시간대와 여유 시간대 파악
- 평일 vs 주말 비교

**팀 대시보드** (관리자 무료)
- 멤버별 사용량 분석 및 한도 초과 추적
- 토큰 사용량 리더보드 및 비용 분석
- 멤버 플랜 변경 요청
- 그룹 관리 및 도메인 기반 자동 초대
- CSV / Excel 내보내기

## 지원 플랜

- Pro (1x) / Max 5x / Max 20x
- Team Standard / Team Premium
- Enterprise (seat-based 및 usage-based)

## 설치

**Chrome Web Store** (권장):

[Claude Tuner 설치](https://chromewebstore.google.com/detail/claude-tuner/ajnnckikagphjbgpicpoffockabnhond)

**수동 설치** (개발자 모드):

1. 이 저장소를 클론
2. `chrome://extensions/` 열기
3. **개발자 모드** 활성화
4. **압축해제된 확장 프로그램을 로드합니다** 클릭 후 클론한 폴더 선택

## 개인정보 보호

- 대화 내용은 **절대 수집하지 않습니다** — 메시지, 파일, 프롬프트 없음
- 사용률 퍼센트, 리셋 시각, 플랜 정보만 수집
- 셀프 서비스 계정 삭제 가능
- 개인정보처리방침: https://claudetuner.com/privacy/

## 기여

[CONTRIBUTING.md](CONTRIBUTING.md)를 참조하세요.

## 라이선스

[MIT](LICENSE)

---

Claude Tuner는 Anthropic과 제휴하거나 보증받지 않습니다.
토큰 한도는 커뮤니티에서 관찰한 추정치이며 공식 수치가 아닙니다.
