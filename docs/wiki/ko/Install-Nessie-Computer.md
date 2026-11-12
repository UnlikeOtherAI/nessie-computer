# Nessie Computer 설치

[macOS](Mac.md) · [Windows](Windows.md)

[다운로드](https://github.com/UnlikeOtherAI/nessie-computer/releases)

앱에 표시된 코드를 사용해 컴퓨터를 Nessie의 원하는 팀에 추가하세요. 에이전트가 작업하기 전에 접근 권한을 검토하세요.

## Linux

릴리스 페이지에서 적절한 Linux 패키지를 다운로드한 다음 저장한 폴더에서 명령을 실행하세요.

Linux 백그라운드 서비스에는 systemd가 필요합니다. 패키지에는 런타임이 포함되며, APT 또는 DNF가 Git과 tmux를 종속 항목으로 함께 설치합니다.

[Debian / Ubuntu (.deb)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.deb) · [Fedora (.rpm)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.rpm)

```sh
# Debian / Ubuntu
sudo apt install ./Nessie-Computer-Linux-x64.deb

# Fedora
sudo dnf install ./Nessie-Computer-Linux-x64.rpm
```

## `nessie-computer`

설치 후 새 터미널을 열어 명령을 확인하세요.

```sh
nessie-computer --version
nessie-computer --help
nessie-computer add
nessie-computer teams
nessie-computer status
```
