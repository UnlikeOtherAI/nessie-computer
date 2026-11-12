# Εγκατάσταση του Nessie Computer

[macOS](Mac.md) · [Windows](Windows.md)

[Λήψεις](https://github.com/UnlikeOtherAI/nessie-computer/releases)

Χρησιμοποιήστε τον κωδικό της εφαρμογής για να προσθέσετε τον υπολογιστή στην επιθυμητή ομάδα στο Nessie. Ελέγξτε τα δικαιώματα πριν εργαστούν οι πράκτορες.

## Linux

Κατεβάστε το κατάλληλο πακέτο Linux από τη σελίδα εκδόσεων και εκτελέστε την εντολή από τον φάκελο όπου το αποθηκεύσατε.

Οι υπηρεσίες παρασκηνίου Linux απαιτούν systemd. Τα πακέτα περιλαμβάνουν το runtime· το APT ή το DNF εγκαθιστά το Git και το tmux ως εξαρτήσεις.

[Debian / Ubuntu (.deb)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.deb) · [Fedora (.rpm)](https://github.com/UnlikeOtherAI/nessie-computer/releases/latest/download/Nessie-Computer-Linux-x64.rpm)

```sh
# Debian / Ubuntu
sudo apt install ./Nessie-Computer-Linux-x64.deb

# Fedora
sudo dnf install ./Nessie-Computer-Linux-x64.rpm
```

## `nessie-computer`

Μετά την εγκατάσταση, ανοίξτε ένα νέο τερματικό και ελέγξτε την εντολή.

```sh
nessie-computer --version
nessie-computer --help
nessie-computer add
nessie-computer teams
nessie-computer status
```
