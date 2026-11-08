// Reuse the shared settings section, translations and popup without a second UI.
export const linuxSoftwarePage = (source) => {
  const section = (start, end) => {
    const offset = source.indexOf(start)
    const finish = source.indexOf(end, offset)
    if (offset < 0 || finish < 0 || source.indexOf(start, offset + start.length) >= 0) {
      throw new Error('The shared software settings document changed.')
    }
    return source.slice(offset, finish + end.length)
  }
  return `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-src 'none'; connect-src 'none'">
<title>Nessie Executor</title><link rel="stylesheet" href="style.css"></head><body><main>
${section('<section id="software-updates"', '</section>')}
</main>${section('<dialog id="update-dialog"', '</dialog>')}
<script src="native.js"></script><script src="updates-words.js"></script><script src="updates.js"></script>
</body></html>\n`
}
