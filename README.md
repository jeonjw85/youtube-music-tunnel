# YTM Tunnel Desktop

앱 내부 전용 SOCKS5 프록시를 지원하는 Electron 기반 YouTube Music 전용 데스크톱 클라이언트

## 목표

프록시/VPN 터널은 이 애플리케이션에서만 사용합니다.
Windows 전체 시스템 트래픽은 변경되지 않습니다.

## 아키텍처

- Electron 앱 -> 127.0.0.1:1080 SOCKS5
- sing-box -> WireGuard
- 시스템 프록시 설정 변경 없음

Electron 앱은 아래 코드로 자신의 Chromium 프로세스에만 프록시를 적용합니다:

app.commandLine.appendSwitch("proxy-server", proxy)

## 빠른 실행 (처음 1회 포함)

1. 의존성 설치

```powershell
npm install
```

2. Mullvad WireGuard conf를 sing-box 설정으로 변환

```powershell
npm run convert:wg -- --input "C:/Users/your-user/Downloads/your-mullvad.conf" --output "./sing-box/config.json"
```

3. sing-box + Electron 앱을 한 번에 실행

```powershell
npm run start:with-singbox
```

중요:

- 이 실행 창을 닫으면 sing-box도 함께 종료됩니다.
- 실행 중에는 창을 닫지 말고 최소화해서 사용하세요.

프록시 없이 앱만 확인할 때:

```powershell
npm run start:noproxy
```

## 1) Mullvad WireGuard 값 준비

Mullvad VPN 사용 시 .conf 파일에서 아래 값을 준비

- Interface.PrivateKey
- Interface.Address (IPv4 /32 하나 사용)
- Peer.PublicKey
- Peer.Endpoint 호스트와 포트

## 2) sing-box 런타임 설정 생성

권장 방법(자동 변환):

npm run convert:wg -- --input "C:/Users/your-user/Downloads/your-mullvad.conf" --output "./sing-box/config.json"

수동 방법(템플릿 직접 편집):

1. 파일 복사:
    - sing-box/config.template.json -> sing-box/config.json
2. sing-box/config.json의 placeholder 값 채우기
    - endpoints[0].peers[0].address (Endpoint host)
    - endpoints[0].peers[0].port (Endpoint port)
    - endpoints[0].address (Interface Address)
    - endpoints[0].private_key
    - endpoints[0].peers[0].public_key

## 3) 실행

의존성 설치:

npm install

프록시 비활성화로 앱 실행(테스트용):

npm run start:noproxy

sing-box를 수동 실행한 뒤 앱 실행:

1. 터미널 A:
   sing-box run -c ./sing-box/config.json
2. 터미널 B:
   npm run start:proxy

한 번에 같이 실행(권장):

npm run start:with-singbox

## 4) Windows 설치 파일 빌드

npm run build:win

결과물은 dist/ 디렉터리에 생성됩니다.

## 참고 사항

- sing-box(127.0.0.1:1080)가 내려가 있으면 앱에서 원인 안내 프록시 오류 다이얼로그를 표시합니다.
- sing-box/config.json에는 개인 키가 포함되므로 버전 관리에 포함하지 마세요.
- 1080 포트가 이미 사용 중이면 sing-box 설정의 listen_port를 바꾸고 YTM_PROXY도 동일하게 맞추세요.
- 이 프로젝트는 sing-box 1.13+ endpoint 스키마를 사용합니다(legacy wireguard outbound/sniff 필드 미사용)
- 변환 스크립트 옵션:
    - --listen-host (기본값: 127.0.0.1)
    - --listen-port (기본값: 1080)
    - --mtu (기본값: 1280)
