# Suiteáil Nessie Computer

[macOS](Mac.md) · [Windows](Windows.md)

[Íoslódálacha](https://github.com/UnlikeOtherAI/nessie-computer/releases)

Úsáid an cód san aip chun an ríomhaire a chur leis an bhfoireann atá uait in Nessie. Seiceáil na ceadanna sula dtosaíonn na gníomhairí ag obair.

Má chuireann tú an fhoireann chéanna leis arís, coinnítear a nasc agus a ceadanna reatha. Críochnaítear an cealú go huathoibríoch nuair a fhilleann an nasc. Ar Windows, aimsítear Claude Code agus Codex atá suiteáilte trí npm go huathoibríoch.

## Linux

Íoslódáil an pacáiste cuí Linux ón leathanach eisiúintí agus rith an t-ordú ón bhfillteán inar shábháil tú é.

Teastaíonn systemd ó sheirbhísí cúlra Linux. Cuimsíonn na pacáistí an rith-am; suiteálann APT nó DNF Git agus tmux mar spleáchais.

[Debian / Ubuntu (.deb)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.deb) · [Fedora (.rpm)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.rpm)

```sh
# Debian / Ubuntu
sudo apt install ./Nessie-Computer-Linux-x64.deb

# Fedora
sudo dnf install ./Nessie-Computer-Linux-x64.rpm
```

## `nessie-computer`

Tar éis na suiteála, oscail teirminéal nua agus seiceáil an t-ordú.

```sh
nessie-computer --version
nessie-computer --help
nessie-computer add
nessie-computer teams
nessie-computer status
```
