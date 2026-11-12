# Nessie Computer のインストール

[macOS](Mac.md) · [Windows](Windows.md)

[ダウンロード](https://github.com/UnlikeOtherAI/nessie-computer/releases)

アプリに表示されたコードを使って、Nessie の目的のチームにこのコンピューターを追加します。エージェントが作業する前にアクセス権限を確認してください。

## Linux

リリースページから対応する Linux パッケージをダウンロードし、保存先のフォルダーでコマンドを実行してください。

Linuxのバックグラウンドサービスには、systemdが必要です。パッケージにはランタイムが含まれます。APTまたはDNFは、依存関係としてGitとtmuxもインストールします。

[Debian / Ubuntu (.deb)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.deb) · [Fedora (.rpm)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.rpm)

```sh
# Debian / Ubuntu
sudo apt install ./Nessie-Computer-Linux-x64.deb

# Fedora
sudo dnf install ./Nessie-Computer-Linux-x64.rpm
```

## `nessie-computer`

インストール後、新しいターミナルを開いてコマンドを確認してください。

```sh
nessie-computer --version
nessie-computer --help
nessie-computer add
nessie-computer teams
nessie-computer status
```
