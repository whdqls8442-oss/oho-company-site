# 오호컴퍼니 홈페이지 (Vercel 버전)

claude.ai에서 만든 사이트를 그대로 옮기고 유튜브 연동을 붙인 버전이에요.

- **라이브 자동 감지**: 멤버가 유튜브 방송을 켜면 1~2분 안에 "현재 방송중인 멤버"에 자동으로 떠요
- **프로필 사진 자동**: 사진을 따로 안 올린 멤버는 유튜브 채널 사진이 자동으로 나와요
- **구독자 수**: 멤버 카드와 팝업에 유튜브 구독자 수가 나와요
- 로그인 없이 누구나 볼 수 있고, 지원서도 누구나 제출할 수 있어요
- **관리자**: 사이트 맨 아래 "관리자" → 비밀번호 입력 → 모든 수정 기능 사용

## 처음 올리는 순서 (약 20분)

### 1. GitHub에 올리기
1. github.com 로그인 → 오른쪽 위 + → New repository → 이름 `oho-company-site` → Create repository
2. "uploading an existing file" 클릭 → 이 폴더 안의 파일·폴더를 전부 끌어다 놓기 → Commit changes

### 2. Vercel에 연결
1. vercel.com 로그인 → Add New → Project → 방금 만든 저장소 Import → Deploy

### 3. 저장소 2개 연결 (Vercel 프로젝트 화면 → Storage 탭)
1. **Upstash for Redis** → Create → 무료 플랜 → 이 프로젝트에 Connect
   - 사이트 내용(멤버·일정·게시글·지원서)이 여기 저장돼요
2. **Blob** → Create → 이 프로젝트에 Connect
   - 관리자가 올리는 사진이 여기 저장돼요

### 4. 유튜브 API 키 만들기
1. console.cloud.google.com → 새 프로젝트 만들기
2. 왼쪽 메뉴 "API 및 서비스" → "라이브러리" → `YouTube Data API v3` 검색 → 사용
3. "사용자 인증 정보" → "사용자 인증 정보 만들기" → "API 키" → 만들어진 키 복사
4. (권장) 키 수정 → API 제한사항 → YouTube Data API v3만 선택

### 5. 환경변수 넣기 (Vercel → Settings → Environment Variables)
- `ADMIN_PASSWORD` : 관리자 비밀번호 (직접 정하기)
- `YOUTUBE_API_KEY` : 4번에서 복사한 키

넣은 뒤 Deployments → 맨 위 배포 → ⋯ → **Redeploy** 를 눌러야 적용돼요.

## 알아둘 점
- 라이브 자동 감지는 **유튜브 방송만** 돼요. SOOP 방송은 관리자가 멤버 카드에서 "LIVE 켜기"로 표시해요.
- 라이브 확인은 90초마다 해서, 방송을 켠 뒤 화면에 뜨기까지 1~2분 걸릴 수 있어요.
- 유튜브 무료 사용량(하루 10,000)으로 충분해요. 멤버 30명 기준 하루 약 3,000~4,000 사용.
- 처음 배포하면 claude.ai에서 넣은 내용(레이블 2개, 멤버 30명, 일정 15개, 명예의 전당)이 그대로 들어가 있어요.
- 사진은 한 장에 4MB 이하 (큰 사진은 자동으로 줄여서 올라가요).
- 3번(저장소)을 연결하기 전에는 수정한 내용이 저장되지 않아요. 꼭 먼저 연결해 주세요.

## 폴더 구성
- `public/index.html` 사이트 화면
- `public/media` 레이블 로고·배너·멤버 사진 / `public/fonts` 페이퍼로지 폰트
- `api/` 서버 기능 (data 읽기, save 저장, login 관리자, upload 사진, apply 지원서, youtube 연동)
- `api/_seed.json` 처음 내용
