# تثبيت Nessie Computer

[macOS](Mac.md) · [Windows](Windows.md)

[التنزيلات](https://github.com/UnlikeOtherAI/nessie-computer/releases)

استخدم الرمز الظاهر في التطبيق لإضافة هذا الكمبيوتر إلى الفريق المطلوب في Nessie. راجع الأذونات قبل السماح للوكلاء بالعمل.

## Linux

نزّل حزمة Linux المناسبة من صفحة الإصدارات، ثم شغّل الأمر من المجلد الذي حفظتها فيه.

تتطلب خدمات Linux الخلفية systemd. تتضمن الحزم بيئة التشغيل، ويثبّت APT أو DNF برنامجي Git وtmux بوصفهما تبعيات.

[Debian / Ubuntu (.deb)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.deb) · [Fedora (.rpm)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.rpm)

```sh
# Debian / Ubuntu
sudo apt install ./Nessie-Computer-Linux-x64.deb

# Fedora
sudo dnf install ./Nessie-Computer-Linux-x64.rpm
```

## `nessie-computer`

افتح نافذة طرفية جديدة بعد التثبيت، ثم تحقق من الأمر.

```sh
nessie-computer --version
nessie-computer --help
nessie-computer add
nessie-computer teams
nessie-computer status
```
