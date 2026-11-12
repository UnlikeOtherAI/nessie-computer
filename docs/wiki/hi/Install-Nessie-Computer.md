# Nessie Computer इंस्टॉल करें

[macOS](Mac.md) · [Windows](Windows.md)

[डाउनलोड](https://github.com/UnlikeOtherAI/nessie-computer/releases)

ऐप में दिखाए गए कोड से इस कंप्यूटर को Nessie की इच्छित टीम में जोड़ें। एजेंटों को काम करने देने से पहले अनुमतियाँ जाँचें।

## Linux

रिलीज़ पेज से उपयुक्त Linux पैकेज डाउनलोड करें, फिर जिस फ़ोल्डर में उसे सहेजा है, वहाँ से कमांड चलाएँ।

Linux की पृष्ठभूमि सेवाओं के लिए systemd चाहिए। पैकेज रनटाइम साथ लाते हैं; APT या DNF Git और tmux को निर्भरता के रूप में इंस्टॉल करते हैं।

[Debian / Ubuntu (.deb)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.deb) · [Fedora (.rpm)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.rpm)

```sh
# Debian / Ubuntu
sudo apt install ./Nessie-Computer-Linux-x64.deb

# Fedora
sudo dnf install ./Nessie-Computer-Linux-x64.rpm
```

## `nessie-computer`

इंस्टॉल करने के बाद नया टर्मिनल खोलें और कमांड जाँचें।

```sh
nessie-computer --version
nessie-computer --help
nessie-computer add
nessie-computer teams
nessie-computer status
```
