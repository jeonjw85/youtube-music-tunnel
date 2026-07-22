# YTM Tunnel Desktop

**[English](./README.md)**

앱이 직접 관리하는 로컬 SOCKS5 터널을 쓰는 Electron 기반 YouTube Music 데스크톱 클라이언트입니다.

YouTube Music만 터널로 보내고 나머지 Windows 트래픽은 그대로 두고 싶을 때 쓰는 앱입니다. 프록시는 앱의 Electron/Chromium 프로세스에만 적용하고, 번들된 `sing-box` 터널은 앱이 직접 켜고 끕니다. Windows 시스템 프록시는 건드리지 않습니다.

## 기능

- 전용 창에서 YouTube Music 실행
- 앱 트래픽만 로컬 SOCKS5 프록시로 라우팅, 기본 주소는 `socks5://127.0.0.1:1080`
- `sing-box` WireGuard 터널을 앱과 함께 자동 시작·종료, 터미널이나 별도 스크립트 불필요
- 첫 실행 때 고른 WireGuard `.conf` 파일을 터널 설정으로 자동 변환, Mullvad에서 내보낸 파일이면 바로 사용 가능
- 시스템 나머지 트래픽은 그대로 유지
- 트레이, 미디어 키, 이퀄라이저 창 제공

## 아키텍처

```text
YTM Tunnel Desktop - Electron
  -> sing-box 시작, 설치 패키지에 번들됨
  -> 127.0.0.1:1080 SOCKS5
  -> WireGuard endpoint
```

프록시는 다음 명령으로 자체 Chromium 프로세스에만 걸립니다.

```js
app.commandLine.appendSwitch("proxy-server", proxy);
```

Windows 시스템 프록시는 변경되지 않습니다.

## 설치

릴리스에서 Windows 설치 프로그램 `YTM Tunnel Desktop-*-Setup-x64.exe`를 받아 실행하면 끝입니다. `sing-box.exe`가 함께 들어 있어 추가로 설치할 필요 없습니다.

첫 실행 시 WireGuard `.conf` 파일 선택 창이 뜹니다. Mullvad에서 내보낸 파일을 고르면 자동으로 변환한 뒤 터널을 시작합니다. 개인 키는 이 컴퓨터 밖으로 나가지 않습니다.

## 개발 환경 빠른 시작

요구 사항: Windows, Node.js, npm. `sing-box`가 `PATH`에 있을 필요는 없습니다. 앱이 vendor 복사본을 자동으로 찾습니다.

1. 의존성 설치:

```powershell
npm install
```

2. `sing-box` 준비, 둘 중 하나:

```powershell
npm run vendor:singbox   # 공식 릴리스를 vendor/sing-box/에 다운로드
# 또는
winget install SagerNet.sing-box
```

3. 실행:

```powershell
npm start
```

첫 실행 때 `.conf` 파일을 고르면 변환 후 한 번 재시작하고 터널로 연결됩니다. 절차는 이게 전부이고, 이후 `npm start`는 항상 터널과 함께 실행됩니다.

## 터널 설정

- 개발 환경: `./sing-box/config.json`, 저장소 로컬 파일이며 git에서 무시됨
- 설치본: `%APPDATA%\YTM Tunnel Desktop\sing-box\config.json`

첫 실행 때 고른 `.conf`로 앱이 직접 생성합니다. 설정이나 공급자를 바꾸려면 `YTM_RESET_CONFIG=true`로 한 번 실행하면 선택 창이 다시 뜹니다.

로그는 개발 환경에서 설정 파일 옆에, 설치본에서는 `%APPDATA%\YTM Tunnel Desktop\logs\`에 남습니다.

### 수동 변환

명령줄로 직접 변환해도 됩니다.

```powershell
npm run convert:wg -- --input "C:/Users/your-user/Downloads/your-mullvad.conf" --output "./sing-box/config.json"
```

변환기가 읽는 항목은 `Interface.PrivateKey`, `Interface.Address`, `Peer.PublicKey`, `Peer.Endpoint`, `Peer.AllowedIPs`이고, `Reserved`와 `PresharedKey`는 있으면 함께 읽습니다. 옵션 기본값은 `--listen-host`가 `127.0.0.1`, `--listen-port`가 `1080`, `--mtu`가 `1280`입니다.

## 실행

```powershell
npm start              # 앱이 관리하는 sing-box 터널과 함께 실행
npm run start:noproxy  # 터널 없이 실행, 테스트용
```

`am.i.mullvad.net`으로 출구 IP까지 검증하려면:

```powershell
npm run test:tunnel
```

## 환경 변수

- `YTM_USE_PROXY`: `true` 또는 미설정 시 앱 자체 터널 사용, `false` 시 터널 끔
- `YTM_PROXY`: Electron이 쓰는 프록시 URL, 기본값 `socks5://127.0.0.1:1080`. 설정 생성 시 SOCKS5 리스너가 이 포트로 생김
- `YTM_RESET_CONFIG`: `true` 시 첫 실행 선택 창을 다시 띄우고 기존 설정을 덮어씀
- `YTM_MINIMIZE_TO_TRAY`: `true` 시 창을 닫으면 트레이로 들어감
- `YTM_START_HIDDEN`: `true` 시 숨김 상태로 시작

## 앱 조작

- 미디어 키: 재생/일시정지, 다음 트랙, 이전 트랙
- `Ctrl+E`: 이퀄라이저 창
- 트레이 메뉴: 보이기, 재생/일시정지, 다음, 이전, 이퀄라이저, 종료

YouTube Music 외부 링크는 기본 브라우저에서 열립니다.

## Windows 설치본 빌드

```powershell
npm run build:win
```

빌드할 때 공식 `sing-box` 릴리스를 `vendor/sing-box/`에 내려받고, 이미 있으면 건너뜁니다. 갱신하려면 `npm run vendor:singbox -- --force`를 쓰면 됩니다. `sing-box.exe`는 설치 패키지에 번들됩니다. 결과물은 독립 실행형이라 사용자에게는 설치 프로그램과 `.conf` 파일만 있으면 됩니다.

빌드 결과물은 `dist/`에 나옵니다. Windows 빌드는 `electron-builder`의 NSIS 대상을 사용합니다.

## 문제 해결

### "Tunnel failed to start" 대화상자

대화상자에 `sing-box` 오류 출력이 함께 표시됩니다. 흔한 원인:

- 다른 프로그램이 SOCKS5 포트를 이미 사용 중인 경우. 기본 포트는 1080. 해당 프로그램을 종료하거나, 설정을 삭제하고 다른 `YTM_PROXY` 포트로 실행해 처음부터 다시 진행하세요.
- WireGuard 키나 엔드포인트가 만료되거나 유효하지 않은 경우. Mullvad 키를 교체한 뒤가 대표적입니다. `YTM_RESET_CONFIG=true`로 실행해 새 `.conf`를 선택하세요.
- 설정을 직접 편집하다 망가진 경우.

### `YTM_PROXY` 포트 불일치

설정의 리스닝 포트가 `YTM_PROXY`와 다르면 앱은 터널 시작을 거부하고 사유를 알려줍니다. 설정을 삭제하거나 `YTM_RESET_CONFIG=true`로 실행해 현재 포트에 맞게 다시 만드세요.

### sing-box를 찾지 못함, 개발 환경

```powershell
npm run vendor:singbox
# 또는
winget install SagerNet.sing-box
```

개발 환경에서 앱은 `vendor/sing-box/`, `PATH`, winget 패키지 디렉터리 순서로 `sing-box.exe`를 찾습니다.

## 참고

- 터널 설정은 비밀 정보를 담은 로컬 런타임 파일입니다. 커밋하거나 업로드하지 마세요.
- 이 프로젝트는 `sing-box` 1.13 이상의 엔드포인트 스키마를 사용합니다.
- 레거시 WireGuard 아웃바운드와 스니프 필드는 쓰지 않습니다.
- 이 앱은 의도적으로 YouTube Music과 자체 터널링에만 범위를 제한합니다.
