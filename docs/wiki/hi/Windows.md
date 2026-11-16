# Nessie Computer — Windows

[Nessie Computer इंस्टॉल करें](Install-Nessie-Computer.md)

[डाउनलोड: `Nessie-Computer-Windows-x64.msi`](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Windows-x64.msi)

Windows 10 22H2 या नया संस्करण, x64 चाहिए। MSI खोलें, इंस्टॉलेशन की अनुमति दें और Start से Nessie Computer खोलें। आइकन सूचना क्षेत्र के छिपे हुए आइकनों में हो सकता है।

ऐप में दिखाए गए कोड से इस कंप्यूटर को Nessie की इच्छित टीम में जोड़ें। एजेंटों को काम करने देने से पहले अनुमतियाँ जाँचें।

अनुमति देने से पहले पुष्टि करें कि प्रकाशक **UnlikeOtherAI s.r.o.** है। इंस्टॉल करने के बाद नई PowerShell विंडो खोलें और इंस्टॉल किए गए कमांड की जाँच करें:

```powershell
nessie-computer --version
nessie-computer --help
```

अपडेट करने से पहले चल रहा काम पूरा होने दें और Nessie Computer खुला रखें। इंस्टॉलर ऐप को फिर से शुरू करता है और पुराने कनेक्शन लॉक तभी हटाता है जब Windows पुष्टि करता है कि मूल प्रक्रिया समाप्त हो चुकी है। टीम की सेटिंग और इतिहास सुरक्षित रहते हैं।
