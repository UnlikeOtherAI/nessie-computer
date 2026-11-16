# Nessie Computer — Windows

[Nessie Computer のインストール](Install-Nessie-Computer.md)

[ダウンロード: `Nessie-Computer-Windows-x64.msi`](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Windows-x64.msi)

Windows 10 22H2 以降の x64 版が必要です。MSI を開いてインストールを許可し、スタートメニューから Nessie Computer を起動します。アイコンは通知領域の非表示アイコンに入っている場合があります。

アプリに表示されたコードを使って、Nessie の目的のチームにこのコンピューターを追加します。エージェントが作業する前にアクセス権限を確認してください。

承認する前に、発行元が **UnlikeOtherAI s.r.o.** であることを確認してください。インストール後、新しい PowerShell ウィンドウを開き、インストールされたコマンドを確認します。

```powershell
nessie-computer --version
nessie-computer --help
```

更新する前に、実行中の作業が完了するまで待ってください。Nessie Computer のインストーラーは、元のプロセスが終了したことを Windows が確認した場合にのみ、古い接続ロックを削除します。チームの設定と履歴は保持されます。
